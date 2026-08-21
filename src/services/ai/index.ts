import { config } from '../../config.js';
import type { Company } from '../../core/companies.js';
import type { Conversation } from '../../core/conversation.js';
import { runClaudeTurn } from '../claude/agent.js';
import { runGeminiTurn } from './gemini.agent.js';
import type { AgentDeps, AgentResult } from './tool-exec.js';

export type { AgentDeps, AgentResult } from './tool-exec.js';

/**
 * Run one assistant turn with the configured provider. Gemini is preferred
 * when GEMINI_API_KEY is set; Claude (ANTHROPIC_API_KEY) is the fallback.
 * Both share the tool set, the system prompt and the stored history format,
 * so the provider can be switched without losing conversations.
 */
export async function runAgentTurn(
  convo: Conversation,
  deps: AgentDeps,
  company: Company,
): Promise<AgentResult> {
  if (config.features.gemini) return runGeminiTurn(convo, deps, company);
  return runClaudeTurn(convo, deps, company);
}
