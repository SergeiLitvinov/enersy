export interface Identity { accountId: string; sessionId: string; expiresAt: string }
export interface Project { id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'viewer' }
export interface ProjectPage { items: Project[]; nextAfterId: string }
export interface ProjectScheme { id: string; name: string; description: string }
export interface ProjectSchemePage { items: ProjectScheme[]; nextAfterId: string }
export class SessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный ответ сервера');
  return value as Record<string, unknown>;
}
function projectPath(project: string) {
  if (!decimal(project)) throw new Error('Некорректный ID проекта');
  return `/api/projects/${project}/schemes`;
}
export async function listProjectSchemes(project: string, signal: AbortSignal, afterId = ''): Promise<ProjectSchemePage> {
  if (afterId && !decimal(afterId)) throw new Error('Некорректная страница схем');
  const data = record(await request(`${projectPath(project)}?limit=20${afterId ? `&afterId=${afterId}` : ''}`, 'GET', signal));
  if (!Array.isArray(data.items) || (data.nextAfterId !== undefined && !decimal(data.nextAfterId))) throw new Error('Некорректный список схем');
  const items = data.items.map(value => {
    const item = record(value);
    if (!decimal(item.id) || typeof item.name !== 'string' || typeof item.description !== 'string') throw new Error('Некорректная карточка схемы');
    return { id: item.id, name: item.name, description: item.description };
  });
  return { items, nextAfterId: typeof data.nextAfterId === 'string' ? data.nextAfterId : '' };
}
export async function createProjectScheme(project: string, name: string, description: string, signal: AbortSignal): Promise<string> {
  const data = record(await request(projectPath(project), 'POST', signal, { name, description }));
  if (!decimal(data.id)) throw new Error('Создание схемы не подтверждено');
  return data.id;
}
export async function readProjectScheme(project: string, scheme: string, signal: AbortSignal): Promise<unknown> {
  if (!decimal(scheme)) throw new Error('Некорректный ID схемы');
  return request(`${projectPath(project)}/${scheme}`, 'GET', signal);
}
async function request(path: string, method: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(path, { method, signal, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new SessionError(response.status, response.status === 401 ? 'Сессия завершена или данные входа неверны' :
    response.status === 503 ? 'Сервис входа временно недоступен' : 'Не удалось выполнить запрос. Повторите попытку');
  return response.status === 204 ? null : response.json();
}
function identity(value: unknown): Identity {
  const data = record(value);
  if (!decimal(data.accountId) || !decimal(data.sessionId) || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error('Некорректная сессия сервера');
  return { accountId: data.accountId, sessionId: data.sessionId, expiresAt: data.expiresAt };
}
export async function readSession(signal: AbortSignal): Promise<Identity | null> {
  try { return identity(await request('/api/auth/session', 'GET', signal)); }
  catch (error) { if (error instanceof SessionError && error.status === 401) return null; throw error; }
}
export async function login(login: string, password: string, signal: AbortSignal): Promise<Identity> {
  return identity(await request('/api/auth/login', 'POST', signal, { login, password }));
}
export async function logout(all: boolean, signal: AbortSignal): Promise<void> {
  try { await request(all ? '/api/auth/logout-all' : '/api/auth/logout', 'POST', signal); }
  catch (error) { if (!(error instanceof SessionError && error.status === 401)) throw error; }
}
export async function listProjects(signal: AbortSignal, afterId = ''): Promise<ProjectPage> {
  if (afterId && !decimal(afterId)) throw new Error('Некорректная страница проектов');
  const data = record(await request(`/api/projects?limit=20${afterId ? `&afterId=${afterId}` : ''}`, 'GET', signal));
  if (!Array.isArray(data.items) || (data.nextAfterId !== undefined && !decimal(data.nextAfterId))) throw new Error('Некорректный список проектов');
  const items = data.items.map(value => {
    const item = record(value);
    if (!decimal(item.id) || typeof item.name !== 'string' || !['owner', 'admin', 'editor', 'viewer'].includes(String(item.role))) throw new Error('Некорректная карточка проекта');
    return { id: item.id, name: item.name, role: item.role as Project['role'] };
  });
  return { items, nextAfterId: typeof data.nextAfterId === 'string' ? data.nextAfterId : '' };
}
export async function createProject(name: string, signal: AbortSignal): Promise<void> {
  const data = record(await request('/api/projects', 'POST', signal, { name }));
  if (!decimal(data.id)) throw new Error('Создание проекта не подтверждено');
}
