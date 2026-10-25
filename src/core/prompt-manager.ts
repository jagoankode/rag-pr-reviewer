import { getQdrantClient } from './db.js';
import { loadConfig } from './config.js';

// ID khusus system-prompt dalam format UUID v4
export const SYSTEM_PROMPT_POINT_ID = '6642a3e4-6954-48e8-a5eb-c1723960aa78';

export const DEFAULT_AUDIT_PROMPT_TEMPLATE = `You are a strict Code Convention Auditor.
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
   - Compare the file name ({{FILE_PATH}}) and its folder against the module structure convention (e.g. Section 2.1).
   - If the file name itself violates conventions (e.g., using plural suffix like ".helpers.ts" instead of singular ".helper.ts", wrong extension, or invalid naming pattern), YOU MUST flag it on line 1 of the file.
   - If required module files (e.g., wrapper, container, component, hook, index.ts, test files) are missing according to the registered convention, flag it on line 1 of the file under review.
{{SCOPE_INSTRUCTION}}
5. Every violation MUST cite the exact [Rule Title] from the registered conventions as its "rule" property.
6. If the file, its name, and its folder adhere to all registered conventions, return empty violations array [].
7. SuggestedFix must be an actionable replacement code snippet or null if not applicable.

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
`;

/**
 * Mengambil template prompt audit dari DB (Qdrant) jika tersedia,
 * dengan fallback ke DEFAULT_AUDIT_PROMPT_TEMPLATE jika offline/belum diset.
 */
export async function getDynamicAuditPromptTemplate(): Promise<string> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();
      
      // 1. Coba retrieve via UUID tetap
      const points = await client.retrieve(collection, {
        ids: [SYSTEM_PROMPT_POINT_ID],
        with_payload: true,
      });

      if (points.length > 0 && points[0].payload?.content) {
        return String(points[0].payload.content);
      }

      // 2. Fallback query: cari point dengan source: 'system-prompt'
      const scrollRes = await client.scroll(collection, {
        filter: {
          must: [
            { key: 'source', match: { value: 'system-prompt' } },
          ],
        },
        limit: 1,
        with_payload: true,
      });

      if (scrollRes.points && scrollRes.points.length > 0 && scrollRes.points[0].payload?.content) {
        return String(scrollRes.points[0].payload.content);
      }
    } catch {
      // Fallback ke default template jika offline
    }
  }

  return DEFAULT_AUDIT_PROMPT_TEMPLATE;
}

/**
 * Menyimpan / memperbarui template prompt audit di Qdrant
 */
export async function saveDynamicAuditPromptTemplate(template: string): Promise<boolean> {
  const { client, collection } = await getQdrantClient();
  const now = new Date().toISOString();

  // Simpan dengan vector dummy agar sesuai skema qdrant (3072 dimensi)
  const dummyVector = new Array(3072).fill(0);

  await client.upsert(collection, {
    wait: true,
    points: [
      {
        id: SYSTEM_PROMPT_POINT_ID,
        vector: dummyVector,
        payload: {
          originalId: String(SYSTEM_PROMPT_POINT_ID),
          source: 'system-prompt',
          title: 'System Review Audit Prompt Template',
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
