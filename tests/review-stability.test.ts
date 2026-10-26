import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditFile, coreAudit, summarizeAudit, stableFindings } from '../src/core/review-engine.js';
import { snapshotRules } from '../src/core/review-rules.js';
import { snapshotReview } from '../src/core/review-snapshot.js';
import { chunkMarkdown } from '../src/core/chunker.js';
import { parseAnnotatedDiffFiles } from '../src/core/diff-parser.js';
import { formatReportToMarkdown } from '../src/core/history.js';
import { ReviewInput } from '../src/core/review-input.js';
const input: ReviewInput = { file:'a.ts', content:'const a = 1;\n', folderFiles:['b.ts','a.ts'], addedLines:[1], diff:'diff', scope:'full', hash:'untrusted' };
const rules = snapshotRules([{ id:'no-var', source:'team', title:'N1 Declarations', content:'- Never use `var`; always use `const` by default.', checks:[{ type:'forbid-syntax', syntax:'var', severity:'error', message:'Use const instead of var.' }] }]);
const refs = {base:'base',head:'head',mergeBase:'ancestor',mode:'committed-pr'};
test('deterministic findings are identical across repeated, uncached runs',()=>{
 const i={...input,content:'var a = 1;\nvar b = 2;\n'};
 const first=coreAudit(i,rules);
 assert.equal(first.violations.length,2);
 for(let n=0;n<20;n++) assert.deepEqual(coreAudit(JSON.parse(JSON.stringify(i)),snapshotRules(JSON.parse(JSON.stringify(rules.rules)))),first);
 assert.equal(summarizeAudit([first],rules).status,'REQUEST_CHANGES');
 const original=[...first.violations];stableFindings(original);assert.deepEqual(original,first.violations);
});
test('fingerprint canonical order, actual input rather than supplied hash, no AI/config secrets',()=>{
 const first=snapshotReview([input],rules,'raw',refs);
 assert.deepEqual(first,snapshotReview([{...input,hash:'different',folderFiles:['a.ts','b.ts']}],rules,'raw',refs));
 for(const changed of [snapshotReview([{...input,content:'changed'}],rules,'raw',refs),snapshotReview([input],rules,'other',refs),snapshotReview([input],rules,'raw',{...refs,head:'new'}),snapshotReview([input],rules,'raw',{...refs,base:'new'}),snapshotReview([input],rules,'raw',refs,'diff'),snapshotReview([input],snapshotRules([{...rules.rules[0],content:'new'}]),'raw',refs)]) assert.notEqual(first.fingerprint,changed.fingerprint);
});
test('short rules retained; distinct same-basename documents do not overwrite; checkout paths stable',()=>{
 const a=chunkMarkdown('No var.','/machine-a/docs/rules.md');
 const b=chunkMarkdown('No any.','/machine-b/docs/rules.md');
 assert.equal(a.length,1);assert.notEqual(a[0].id,b[0].id);
 assert.equal(a[0].id,chunkMarkdown('No var.','/other-checkout/docs/rules.md')[0].id);
});
test('deleted files are skipped without blocking the verdict',async()=>{
 const deleted=parseAnnotatedDiffFiles('diff --git a/a.ts b/a.ts\ndeleted file mode 100644\nindex abcdef1..0000000\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-const a = 1;\n');
 assert.equal(deleted.length,1);assert.equal(deleted[0].unavailable,'File deleted');
 const gone=await auditFile({...input,file:'gone.ts',skipped:deleted[0].unavailable},rules,async()=>{throw Error('AI must not be called');});
 const result=summarizeAudit([coreAudit(input,rules),gone],rules);
 assert.equal(result.status,'APPROVE');
 assert.deepEqual(result.skippedFiles,[{file:'gone.ts',reason:'File deleted'}]);
});
test('saved report groups findings per file and exposes snapshot, branch findings and skipped files',()=>{
 const result=summarizeAudit([coreAudit({...input,content:'var a = 1;\n'},rules),{file:'gone.ts',violations:[],coverage:[],complete:true,skipped:'File deleted'}],rules,
  [{ruleId:'G1',rule:'G1 Commits',check:'commit-message',severity:'error',subject:'abc fix',comment:'Commit tidak sesuai format.',suggestedFix:null}]);
 result.reviewSnapshot=snapshotReview([input],rules,'raw',refs);
 const md=formatReportToMarkdown(result);
 for(const text of [result.reviewSnapshot.fingerprint,'### `a.ts`','| 1 | error |','Branch & Commit','abc fix','Skipped Files','gone.ts','ancestor'])assert.ok(md.includes(text),text);
});

test('two independent repository checkouts produce identical core result and fingerprint',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const {getGitDiff}=await import('../src/core/git.js');
 const {captureReviewInputs}=await import('../src/core/review-input.js');
 const {resolveReviewRefs}=await import('../src/core/review-snapshot.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lumio-independent-'));
 const first=path.join(root,'developer'),second=path.join(root,'senior');fs.mkdirSync(first);
 const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git(first,'init','-q');git(first,'config','user.email','test@example.invalid');git(first,'config','user.name','Test');
  fs.writeFileSync(path.join(first,'a.ts'),'const a = 1;\n');git(first,'add','.');git(first,'commit','-qm','base');const base=git(first,'rev-parse','HEAD');
  fs.writeFileSync(path.join(first,'a.ts'),'var a = 1;\n');git(first,'add','.');git(first,'commit','-qm','head');const head=git(first,'rev-parse','HEAD');
  git(root,'clone','-q',first,second);
  // Host-specific diff preferences must not change captured input.
  git(second,'config','diff.algorithm','histogram');git(second,'config','diff.context','9');git(second,'config','core.abbrev','5');
  const reports=[];
  for(const cwd of [first,second]) {
   const raw=await getGitDiff({cwd,sourceBranch:head,targetBranch:base});
   const inputs=captureReviewInputs(parseAnnotatedDiffFiles(raw),{source:head,target:base},cwd);
   const s=snapshotRules(JSON.parse(JSON.stringify(rules.rules)));
   reports.push({...summarizeAudit(inputs.map(i=>coreAudit(i,s)),s),reviewSnapshot:snapshotReview(inputs,s,raw,resolveReviewRefs({source:head,target:base},cwd))});
  }
  assert.deepEqual(reports[0],reports[1]);
  assert.equal(reports[0].status,'REQUEST_CHANGES');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
