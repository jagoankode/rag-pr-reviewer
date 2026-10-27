import { getQdrantClient } from './db.js';
import { loadConfig } from './config.js';
import { logError } from './logger.js';

export type PromptKey = 'dialog-chat' | 'learn-mining';

export interface PromptDefinition {
  id: string;
  promptKey: PromptKey;
  title: string;
  defaultTemplate: string;
}

export const PROMPT_REGISTRY: Record<PromptKey, PromptDefinition> = {
  'dialog-chat': {
    id: '689baed2-dc0a-4093-a198-393a94a3b802',
    promptKey: 'dialog-chat',
    title: 'System Dialog Chat Q&A Prompt Template',
    defaultTemplate: `You are an AI assistant answering questions about the team's internal coding guidelines.
You are chatting directly in a CLI terminal interface.

CRITICAL DIRECTIVES:
1. STRICT ZERO-ASSUMPTION GROUNDING: You ONLY answer based on the STORED CONVENTIONS below.
2. STRICT RELEVANCE & FOCUS: Answer ONLY what is explicitly asked. Do NOT explain other topics.
   - For example: if user asks about "variable naming", explain ONLY variable naming. Do NOT include typing policy, function rules, or unrelated topics unless asked.
3. NO MARKDOWN FORMATTING (CLI TERMINAL):
   - DO NOT use markdown bold (no ** or __).
   - DO NOT use markdown code blocks (no \`\`\` or \`).
   - If providing code examples, write them as plain indented text.
   - Use simple clean bullets (•) for lists.
4. If not found in STORED CONVENTIONS, say in one sentence that you have no information about that rule.
5. Respond in clear, polite, natural {{LANGUAGE}}.

=== DAFTAR ATURAN TIM ===
{{ALL_TITLES_SUMMARY}}

=== ISI DETAIL ATURAN YANG RELEVAN ===
{{KNOWLEDGE_CONTEXT}}
=======================================
`,
  },
  'learn-mining': {
    id: 'ab31817e-b00d-4099-b6ee-0a01b6e3c96d',
    promptKey: 'learn-mining',
    title: 'System Codebase Mining Prompt Template',
    defaultTemplate: `You are a Principal Software Architect.
Analyze the following source code files from a local feature/module folder ({{FOLDER_NAME}}).
First identify what kind of code this is (for example UI components, hooks, API routes, services, data models, CLI commands
or tests) and trace how its parts depend on each other.

Reverse-engineer the implicit and explicit CODING CONVENTIONS, architecture patterns, and rules that this team follows.
Extract only patterns the code shows consistently; do not add generic best practices.

Cover whatever applies to this code, such as:
- File and folder structure, and how responsibilities are split between files
- Naming conventions (files, variables, functions, types)
- Typing, data flow and state handling
- Error handling and validation
- Testing patterns

Return ONLY valid JSON matching this schema:
{
  "featureName": "string",
  "architectureSummary": "string",
  "rules": [
    {
      "layer": "area this rule applies to, as the codebase names it (e.g. component, hook, route, service, model, test, general)",
      "title": "string",
      "convention": "string",
      "exampleGood": "string or null"
    }
  ]
}

Source Code from folder:
{{CODE_CONTEXT}}
`,
  },
};

/**
 * Mengambil prompt template dari DB (Qdrant) berdasarkan key,
 * dengan fallback ke default template jika offline atau belum diisi di DB.
 */
export async function getDynamicPrompt(key: PromptKey): Promise<string> {
  const def = PROMPT_REGISTRY[key];
  if (!def) return '';

  const config = await loadConfig();
  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();

      // 1. Coba retrieve via UUID point
      const points = await client.retrieve(collection, {
        ids: [def.id],
        with_payload: true,
      });

      if (points.length > 0 && points[0].payload?.content) {
        return String(points[0].payload.content);
      }

      // 2. Fallback query: cari point dengan promptKey sama
      const scrollRes = await client.scroll(collection, {
        filter: {
          must: [
            { key: 'source', match: { value: 'system-prompt' } },
            { key: 'promptKey', match: { value: key } },
          ],
        },
        limit: 1,
        with_payload: true,
      });

      if (scrollRes.points && scrollRes.points.length > 0 && scrollRes.points[0].payload?.content) {
        return String(scrollRes.points[0].payload.content);
      }
    } catch (err: any) {
      logError('prompt-manager', `Failed retrieving dynamic prompt for [${key}], using fallback: ${err?.message}`);
    }
  }

  return def.defaultTemplate;
}

export async function getDynamicDialogPromptTemplate(): Promise<string> {
  return await getDynamicPrompt('dialog-chat');
}

export async function getDynamicLearnPromptTemplate(): Promise<string> {
  return await getDynamicPrompt('learn-mining');
}

/**
 * Menyimpan / memperbarui prompt template di Qdrant
 */
export async function saveDynamicPrompt(key: PromptKey, template: string): Promise<boolean> {
  const def = PROMPT_REGISTRY[key];
  if (!def) return false;

  const { client, collection } = await getQdrantClient();
  const now = new Date().toISOString();
  const dummyVector = new Array(3072).fill(0);

  await client.upsert(collection, {
    wait: true,
    points: [
      {
        id: def.id,
        vector: dummyVector,
        payload: {
          originalId: def.id,
          promptKey: key,
          source: 'system-prompt',
          title: def.title,
          content: template,
          status: 'ACTIVE',
          created_at: now,
          updated_at: now,
        },
      },
    ],
  });

  return true;
}
