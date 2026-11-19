export type {
  Account, AccountState, ChatMessage, Project, ProjectSettings, Role, Skill, Task, TaskStatus, QuotaWindow, Provider,
} from '../../src/shared/types.ts';

export interface AcceptanceItemLike { id: string; criterion: string; verify: string; pass?: boolean | null; evidence?: string }
