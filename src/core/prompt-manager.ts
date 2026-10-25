import { getQdrantClient } from './db.js';
import { loadConfig } from './config.js';
import { logError } from './logger.js';

export type PromptKey = 'audit-pr' | 'dialog-chat' | 'learn-mining';

export interface PromptDefinition {
  id: string;
  promptKey: PromptKey;
  title: string;
  defaultTemplate: string;
}

export const PROMPT_REGISTRY: Record<PromptKey, PromptDefinition> = {
  'audit-pr': {
    id: '6642a3e4-6954-48e8-a5eb-c1723960aa78',
    promptKey: 'audit-pr',
    title: 'System Review Audit Prompt Template',
    defaultTemplate: `You are a strict Code Convention Auditor.
Your ONLY job is to verify if this code, its file name, and its module folder violate the EXPLICIT registered conventions provided below.

### REGISTERED TEAM CONVENTIONS (EXACT TRUTH FROM VECTOR DB):
{{REGISTERED_CONVENTIONS}}

### MODULE CONTEXT & SURROUNDING FOLDER:
- File Under Review: {{FILE_PATH}}
- Containing Folder: {{CONTAINING_FOLDER}}
- Files Present in this Folder: [{{FOLDER_FILES}}]

### COMPLETE FILE CONTENT WITH PHYSICAL LINE NUMBERS:
{{FILE_CONTENT}}

### RECENT GIT CHANGES (DIFF):
{{FILE_DIFF}}

### STRICT AUDIT RULES:
1. ZERO ASSUMPTIONS: You must ONLY flag violations against the exact rules listed in "REGISTERED TEAM CONVENTIONS" above.
2. DO NOT use generic best practices, personal styling preferences, clean architecture opinions, or external internet standards.
3. FILE NAMING & SCAFFOLD AUDIT:
   - Compare the file name ({{FILE_PATH}}) against the registered architecture and file naming conventions.
   - UNRECOGNIZED / INVALID SCAFFOLD FILE:
     * If a file uses an invalid or non-standard suffix, plural naming (e.g. '.helpers.ts' instead of '.helper.ts' or '.helper.tsx'), or is not part of the standard module scaffold:
       You MUST flag it on line 1 citing the exact rule.
       The comment MUST specifically explain that the file name or suffix does NOT exist in the standard scaffold, and guide the developer to the correct standard scaffold naming pattern (e.g. 'ModuleName.helper.ts' or 'ModuleName.helper.tsx').
       NEVER falsely claim that the folder is missing container, snapshot, or other module files just because a file name is mistyped or unrecognized!
   - MODULE SCAFFOLD COMPLETENESS:
     * ONLY flag missing module files (like container or snapshot tests) if the folder is an actual top-level module containing valid standard module files, NOT for sub-components or folders with unrecognized/mistyped files.
   - If the file name violates registered naming conventions (e.g. wrong casing, invalid suffix/prefix, forbidden extension, or non-compliant pattern), YOU MUST flag it on line 1 of the file.
{{SCOPE_INSTRUCTION}}
5. Every violation MUST cite the exact [Rule Title] from the registered conventions as its "rule" property.
6. If the file, its name, and its folder adhere to all registered conventions, return empty violations array [].
7. SuggestedFix must be an actionable replacement code snippet or null if not applicable.

### GRANULARITY & ATOMIC VIOLATIONS DIRECTIVE (1 MISTAKE = 1 COMMENT):
- STRICT ATOMICITY: Every single distinct violation MUST be emitted as an INDEPENDENT object in the "violations" array.
- NEVER group, bundle, or concatenate multiple violations into a single bulleted or compound comment.
- If a single file or line has 5 distinct mistakes, produce exactly 5 separate violation entries in the array, each pinpointing the exact line and its specific rule.
- Each violation comment must be concise, dedicated solely to THAT specific mistake, and never mention other unrelated errors in the same comment.

Return strictly a JSON object with this shape:
{
  "violations": [
    {
      "file": "{{FILE_PATH}}",
      "line": 1,
      "rule": "[Exact Rule Title from Registered Conventions]",
      "severity": "error",
      "comment": "Clear explanation referencing the rule and naming convention",
      "suggestedFix": null
    }
  ],
  "notes": []
}
`,
  },
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
4. If not found in STORED CONVENTIONS, answer exactly: "Saya belum mempunyai informasi mengenai aturan itu."
5. Respond in clear, polite, natural Indonesian.

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
Trace the flow from entrypoint/route down to business logic and data layer.

Reverse-engineer the implicit and explicit CODING CONVENTIONS, architecture patterns, and rules that this team follows.

Extract rules across these categories:
- Routing & Controller patterns (input validation, error handling, status codes)
- Service / Business logic rules (DTO usage, typing, pure logic vs side effects)
- Model & Database persistence conventions
- Naming conventions (files, variables, interfaces)

Return ONLY valid JSON matching this schema:
{
  "featureName": "string",
  "architectureSummary": "string",
  "rules": [
    {
      "layer": "routing | service | model | general",
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

// Aliases untuk backward compatibility
export const SYSTEM_PROMPT_POINT_ID = PROMPT_REGISTRY['audit-pr'].id;
export const DEFAULT_AUDIT_PROMPT_TEMPLATE = PROMPT_REGISTRY['audit-pr'].defaultTemplate;

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

export async function getDynamicAuditPromptTemplate(): Promise<string> {
  return await getDynamicPrompt('audit-pr');
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

export async function saveDynamicAuditPromptTemplate(template: string): Promise<boolean> {
  return await saveDynamicPrompt('audit-pr', template);
}
