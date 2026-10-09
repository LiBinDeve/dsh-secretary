/**
 * Secretary tools: create projects (Workspaces) and run threads (Sessions)
 * inside them, from the secretary Agent preset.
 *
 * Every tool acts through Host services only, so the Harness Web sidebar shows
 * the same projects and threads live. Project directories are created beneath
 * the secretary Session's own cwd, which is already the Session's sandbox
 * boundary, so no tool is granted access it did not have.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** Host services this plugin needs; all ship with the web profile. */
export const inject = ['tools', 'workspaceRegistry', 'sessionController', 'sessionQuery']

const DEFAULT_THREAD_LIMIT = 40
const DEFAULT_MESSAGE_LIMIT = 8
const MESSAGE_TEXT_LIMIT = 1200
const MAX_PROJECT_NAME = 64

/** Compact JSON text result shared by every secretary tool. */
function textRender(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** One registry-ready definition; arguments stay unvalidated, so each body checks its own. */
function secretaryTool(name, description, parameters, body) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textRender(value),
    },
    execute: (args, exec) => body(args === null || typeof args !== 'object' ? {} : args, exec),
  }
}

/** The calling execution's cancellation signal; these Remote methods require a real one. */
function callSignal(exec) {
  const signal = exec?.signal
  return signal instanceof AbortSignal ? signal : new AbortController().signal
}

/** The calling Agent's immutable Session cwd, or undefined outside an Agent scope. */
function callerCwd(exec) {
  const agent = exec?.agent
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** Directory projects are created under: the explicit config value, else the Session's own cwd. */
function projectRoot(ctx, config, exec) {
  const configured = config?.projectRoot
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const cwd = callerCwd(exec)
  if (cwd === undefined) {
    throw new Error('Cannot locate the secretary workspace: this call has no Session cwd and the plugin config sets no projectRoot.')
  }
  return resolve(cwd)
}

/** Reject anything that could escape the root or is illegal on Windows. */
function safeProjectName(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('project name must be a non-empty string')
  }
  const name = raw.trim()
  if (name === '.' || name === '..') throw new Error(`project name "${raw}" is not a directory name`)
  if (name.length > MAX_PROJECT_NAME) throw new Error(`project name must be at most ${MAX_PROJECT_NAME} characters`)
  if (/[\\/:*?"<>|]/.test(name)) {
    throw new Error(`project name "${raw}" may not contain path separators or the reserved characters \\ / : * ? " < > |`)
  }
  if (/^[.\s]|[.\s]$/.test(name)) {
    throw new Error(`project name "${raw}" may not start or end with a dot or whitespace`)
  }
  return name
}

/** Resolve one project by exact id, exact title, exact path, or unique partial title. */
function resolveProject(ctx, reference) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error('a project is required: pass the workspaceId, the exact title, or the directory path')
  }
  const wanted = reference.trim()
  const projects = ctx.workspaceRegistry.list()
  if (projects.length === 0) throw new Error('No projects exist yet. Create one with secretary_create_project.')

  const exact = projects.filter(project => String(project.id) === wanted)
  if (exact.length === 1) return exact[0]

  const byTitle = projects.filter(project => project.title === wanted)
  if (byTitle.length === 1) return byTitle[0]

  const byPath = projects.filter(project => project.path === wanted || project.path === resolve(wanted))
  if (byPath.length === 1) return byPath[0]

  const partial = projects.filter(project => project.title.toLowerCase().includes(wanted.toLowerCase()))
  if (partial.length === 1) return partial[0]

  if (partial.length > 1) {
    const candidates = partial.map(project => `${project.title} (${project.id})`).join(', ')
    throw new Error(`Project "${wanted}" is ambiguous; it matches ${candidates}.`)
  }
  const known = projects.map(project => `${project.title} (${project.id})`).join(', ')
  throw new Error(`No project matches "${wanted}". Known projects: ${known}.`)
}

/** Titles for the given Sessions, tolerating per-Session read failures. */
async function titlesOf(ctx, sessionIds) {
  const titles = new Map()
  if (sessionIds.length === 0) return titles
  try {
    const results = await ctx.sessionQuery.readTitleSnapshots(sessionIds)
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const title = result.value?.title?.title
      if (typeof title === 'string' && title !== '') titles.set(String(result.sessionId), title)
    }
  } catch {
    // Titles are decoration; a corpus-wide failure must not fail the listing.
  }
  return titles
}

/** Derive a thread's state from the last durable event, so it is cold-read safe. */
function threadState(events) {
  if (!Array.isArray(events) || events.length === 0) return { state: 'empty', lastEventAt: null }
  const last = events[events.length - 1]
  const time = typeof last?.time === 'number' ? last.time : null
  if (last?.type === 'turn/end') {
    const kind = last?.data?.reason?.kind
    if (kind === undefined || kind === 'completed') return { state: 'idle', lastEventAt: time }
    return { state: `ended:${kind}`, lastEventAt: time }
  }
  if (last?.type === 'turn/start') return { state: 'starting', lastEventAt: time }
  return { state: 'running', lastEventAt: time }
}

/** Flatten message blocks into plain text for a bounded transcript. */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') {
      if (block.type === 'text') parts.push(block.text)
      continue
    }
    if (block.type === 'tool-call') parts.push(`[called ${String(block.name)}]`)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('\n').trim()
}

/** Append one role-labelled line to a transcript accumulator. */
function pushLine(lines, role, body) {
  const text = body.trim()
  if (text === '') return
  const clipped = text.length > MESSAGE_TEXT_LIMIT ? `${text.slice(0, MESSAGE_TEXT_LIMIT)}…[truncated]` : text
  lines.push({ role, text: clipped })
}

/** Fold a Session event log into the trailing conversation, oldest first. */
function transcript(events, limit) {
  const lines = []
  for (const event of events) {
    if (event?.type === 'user/message') pushLine(lines, 'user', blocksToText(event?.data?.content))
    else if (event?.type === 'assistant/message') pushLine(lines, 'assistant', blocksToText(event?.data?.message?.content))
  }
  return lines.length <= limit ? lines : lines.slice(lines.length - limit)
}

/** The last terminal reason, when the newest turn ended abnormally. */
function lastFailure(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const reason = event?.data?.reason
    const kind = reason?.kind
    if (kind === undefined || kind === 'completed') return null
    return {
      kind,
      detail: reason?.error?.message ?? reason?.reason?.reason ?? null,
    }
  }
  return null
}

/** Create one project directory beneath the root and register it as a Workspace. */
async function createProject(ctx, config, exec, args) {
  const name = safeProjectName(args.name)
  const root = projectRoot(ctx, config, exec)
  const directory = resolve(join(root, name))
  if (directory !== root && !directory.startsWith(root + sep)) {
    throw new Error(`Project directory "${directory}" escapes the secretary workspace "${root}".`)
  }

  const existing = await ctx.workspaceRegistry.resolveByPath(directory)
  if (existing !== undefined) {
    return {
      created: false,
      note: 'That directory is already a project.',
      project: { workspaceId: String(existing.id), title: existing.title, path: existing.path },
    }
  }

  await mkdir(directory, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(directory, typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : name)
  return {
    created: true,
    workspaceRoot: root,
    project: { workspaceId: String(workspace.id), title: workspace.title, path: workspace.path },
  }
}

/** List registered projects with their live directory status and thread counts. */
async function listProjects(ctx, config, exec) {
  const projects = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    let status
    try {
      status = await workspace.status()
    } catch (error) {
      status = `unreadable:${error instanceof Error ? error.message : String(error)}`
    }
    projects.push({
      workspaceId: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
      status,
      threads: workspace.sessionIds.length,
    })
  }
  let workspaceRoot
  try {
    workspaceRoot = projectRoot(ctx, config, exec)
  } catch {
    workspaceRoot = null
  }
  return { workspaceRoot, projectCount: projects.length, projects }
}

/** Create a Session inside a project, attach it, then hand it its first task. */
async function createThread(ctx, config, exec, args) {
  const workspace = resolveProject(ctx, args.project)
  const task = args.task
  if (typeof task !== 'string' || task.trim() === '') {
    throw new Error('task must be a non-empty string: it is the first instruction the new thread receives')
  }

  const created = await ctx.sessionController.create({ workspaceId: workspace.id })
  const sessionId = String(created.sessionId)

  let title = null
  if (typeof args.title === 'string' && args.title.trim() !== '') {
    try {
      const renamed = await ctx.sessionController.rename({ sessionId, title: args.title.trim() })
      title = renamed.title
    } catch (error) {
      title = `rename failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  await ctx.sessionController.prompt(
    {
      requestId: `secretary-${randomUUID()}`,
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task }],
    },
    callSignal(exec),
  )

  return {
    started: true,
    threadId: sessionId,
    project: { workspaceId: String(workspace.id), title: workspace.title, path: workspace.path },
    title,
    note: 'The thread runs on its own. Read it later with secretary_read_thread.',
  }
}

/** Send one follow-up instruction to an existing thread, waking it if it is cold. */
async function sendToThread(ctx, args, exec) {
  const thread = args.thread
  if (typeof thread !== 'string' || thread.trim() === '') throw new Error('thread must be a Session id')
  const message = args.message
  if (typeof message !== 'string' || message.trim() === '') throw new Error('message must be a non-empty string')

  await ctx.sessionController.prompt(
    {
      requestId: `secretary-${randomUUID()}`,
      sessionId: thread.trim(),
      mode: 'queue',
      content: [{ type: 'text', text: message }],
    },
    callSignal(exec),
  )
  return { delivered: true, threadId: thread.trim() }
}

/** Read one thread's state and trailing conversation without waking it. */
async function readThread(ctx, args) {
  const thread = args.thread
  if (typeof thread !== 'string' || thread.trim() === '') throw new Error('thread must be a Session id')
  const sessionId = thread.trim()
  const messageLimit = Number.isInteger(args.messages) && args.messages > 0 ? Math.min(args.messages, 50) : DEFAULT_MESSAGE_LIMIT

  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const titles = await titlesOf(ctx, [sessionId])

  return {
    threadId: sessionId,
    title: titles.get(sessionId) ?? null,
    cwd: snapshot?.session?.cwd ?? null,
    preset: snapshot?.session?.agentPreset ?? null,
    events: events.length,
    uptime: threadState(events),
    failure: lastFailure(events),
    messages: transcript(events, messageLimit),
    note: 'Only the trailing messages are returned; request more with the messages argument.',
  }
}

/** Register every secretary tool in the calling (preset) scope. */
export function apply(ctx, config) {
  const settings = config ?? {}

  ctx.tools.register(secretaryTool(
    'secretary_list_projects',
    'List every project the secretary manages, with its directory, whether that directory still exists, and how many threads it has.',
    { type: 'object', additionalProperties: false },
    (_args, exec) => listProjects(ctx, settings, exec),
  ))

  ctx.tools.register(secretaryTool(
    'secretary_create_project',
    'Create a project: make a directory inside the secretary workspace and register it so it appears as a project with its own threads.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Directory name for the project, such as "web-redesign". No path separators.' },
        title: { type: 'string', description: 'Display title; defaults to the directory name.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    (args, exec) => createProject(ctx, settings, exec, args),
  ))

  ctx.tools.register(secretaryTool(
    'secretary_list_threads',
    'List one project\'s threads with their state (running, idle, or how a turn ended) and last activity time.',
    {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project workspaceId, exact title, directory path, or a unique part of the title.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    async (args, exec) => {
      const workspace = resolveProject(ctx, args.project)
      const ids = [...workspace.sessionIds]
      const titles = await titlesOf(ctx, ids)
      const threads = []
      for (const id of ids.slice(0, DEFAULT_THREAD_LIMIT)) {
        let state = { state: 'unknown' }
        try {
          state = threadState(await ctx.sessionQuery.listEvents(id))
        } catch (error) {
          state = { state: `unreadable:${error instanceof Error ? error.message : String(error)}` }
        }
        threads.push({ threadId: String(id), title: titles.get(String(id)) ?? null, ...state })
      }
      return {
        project: { workspaceId: String(workspace.id), title: workspace.title, path: workspace.path },
        threadCount: ids.length,
        returned: threads.length,
        threads,
      }
    },
  ))

  ctx.tools.register(secretaryTool(
    'secretary_create_thread',
    'Open a new thread inside a project and hand it one task. The thread runs on its own in that project\'s directory; the user sees it under the project in the sidebar.',
    {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project workspaceId, exact title, directory path, or a unique part of the title.' },
        task: { type: 'string', description: 'The complete first instruction for the new thread. It cannot see this conversation.' },
        title: { type: 'string', description: 'Short thread title shown in the sidebar.' },
      },
      required: ['project', 'task'],
      additionalProperties: false,
    },
    (args, exec) => createThread(ctx, settings, exec, args),
  ))

  ctx.tools.register(secretaryTool(
    'secretary_send_to_thread',
    'Send one follow-up instruction to an existing thread. A finished thread wakes up and continues.',
    {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread Session id from secretary_create_thread or secretary_list_threads.' },
        message: { type: 'string', description: 'The instruction to deliver.' },
      },
      required: ['thread', 'message'],
      additionalProperties: false,
    },
    (args, exec) => sendToThread(ctx, args, exec),
  ))

  ctx.tools.register(secretaryTool(
    'secretary_read_thread',
    'Read a thread\'s current state and its trailing messages, without waking it. Use this to report progress to the user.',
    {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'Thread Session id to read.' },
        messages: { type: 'integer', description: `How many trailing messages to return (1-50). Defaults to ${DEFAULT_MESSAGE_LIMIT}.` },
      },
      required: ['thread'],
      additionalProperties: false,
    },
    args => readThread(ctx, args),
  ))
}
