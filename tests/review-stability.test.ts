import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditFile, summarizeAudit, stableFindings } from '../src/core/review-engine.js';
import { snapshotRules } from '../src/core/review-rules.js';
import { snapshotReview } from '../src/core/review-snapshot.js';
import { chunkMarkdown } from '../src/core/chunker.js';
import { parseAnnotatedDiffFiles } from '../src/core/diff-parser.js';
import { formatReportToMarkdown } from '../src/core/history.js';
import { ReviewInput } from '../src/core/review-input.js';
const input: ReviewInput = { file:'a.ts', content:'const a = 1;', folderFiles:['b.ts','a.ts'], addedLines:[1], diff:'diff', scope:'full', hash:'untrusted' };
const rules = snapshotRules([{ id:'no-var', source:'team', title:'No var', content:'Never use `var`.' }]);
const refs = {base:'base',head:'head',mergeBase:'ancestor',mode:'committed-pr'};
const ai = (status:string) => JSON.stringify({coverage:[{ruleId:'no-var',status,reason:'AI claim',violations:status==='FAIL'?[{file:'a.ts',line:1,column:1,severity:'error',comment:'Variable opinion'}]:[]}]});
const core = (r:any) => { const {advisory,advisoryNotes,...rest}=r;return rest; };
test('independent uncached reviews: contradictory AI, malformed response and outage cannot change core',async()=>{
 const results=[];
 for(const response of [ai('PASS'),ai('FAIL'),ai('UNCERTAIN'),'{}','invalid',null]) {
  const freshInput=JSON.parse(JSON.stringify(input));
  const freshRules=snapshotRules(JSON.parse(JSON.stringify(rules.rules)));
  const a=await auditFile(freshInput,freshRules,async()=>{if(response===null)throw Error('offline');return response;});
  results.push(summarizeAudit([a],freshRules));
 }
 assert.ok(results.every(r=>r.status==='APPROVE' && r.violations.length===0));
 for(const r of results) assert.deepEqual(core(r),core(results[0]));
 assert.equal(results[1].advisory?.length,1);
});
test('unmapped residual semantics cannot be approved by AI',async()=>{
 const s=snapshotRules([{...rules.rules[0],content:'Never use `var`. Also ensure secure architecture.'}]);
 const result=summarizeAudit([await auditFile(input,s,async()=>ai('PASS'))],s);
 assert.equal(result.status,'COMMENT');assert.equal(result.complete,false);assert.equal(result.coverage?.[0].status,'UNCERTAIN');
});
test('confirmed findings remain stable despite AI disagreement',async()=>{
 const i={...input,content:'var a = 1;'};
 const a=await auditFile(i,rules,async()=>ai('PASS'));
 const b=await auditFile(i,rules,async()=>ai('FAIL'));
 assert.deepEqual(core(summarizeAudit([a],rules)),core(summarizeAudit([b],rules)));
 assert.equal(summarizeAudit([a],rules).status,'REQUEST_CHANGES');
 const original=[...a.violations];stableFindings(original);assert.deepEqual(original,a.violations);
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
test('deleted and metadata-only changes explicitly remain unverified',async()=>{
 const deleted=parseAnnotatedDiffFiles('diff --git a/a.ts b/a.ts\ndeleted file mode 100644\nindex abcdef1..0000000\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-const a = 1;\n');
 assert.equal(deleted.length,1);assert.ok(deleted[0].unavailable);
 const result=summarizeAudit([await auditFile({...input,error:deleted[0].unavailable},rules,async()=>ai('PASS'))],rules);
 assert.equal(result.status,'COMMENT');assert.equal(result.complete,false);
});
test('empty rules / empty audits never complete or approve',()=>{
 for(const s of [rules,snapshotRules([])]) {const r=summarizeAudit([],s);assert.equal(r.complete,false);assert.equal(r.status,'COMMENT');}
});
test('saved report exposes snapshot, coverage and advisory boundary',async()=>{
 const result=summarizeAudit([await auditFile(input,rules,async()=>ai('FAIL'))],rules);
 result.reviewSnapshot=snapshotReview([input],rules,'raw',refs);
 const md=formatReportToMarkdown(result);
 for(const text of [result.reviewSnapshot.fingerprint,'Deterministic rule coverage','Unverified AI advisory','no-var','ancestor'])assert.ok(md.includes(text));
});

test('two independent repository checkouts produce identical uncached core and fingerprint',async()=>{
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
  for(const [i,cwd] of [first,second].entries()) {
   const raw=await getGitDiff({cwd,sourceBranch:head,targetBranch:base});
   const inputs=captureReviewInputs(parseAnnotatedDiffFiles(raw),{source:head,target:base},cwd);
   const s=snapshotRules(JSON.parse(JSON.stringify(rules.rules)));
   const audits=await Promise.all(inputs.map(input=>auditFile(input,s,async()=>ai(i?'FAIL':'PASS'))));
   reports.push({...core(summarizeAudit(audits,s)),reviewSnapshot:snapshotReview(inputs,s,raw,resolveReviewRefs({source:head,target:base},cwd))});
  }
  assert.deepEqual(reports[0],reports[1]);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('negated, conditional and modified prose cannot activate a checker by substring',async()=>{
 for(const content of ['Do not enforce: Never use `var`.', 'Never use `var` unless generated.', 'If this is production: Never use `var`.', 'Explicit parameter and return types are mandatory in every function signature except tests.', 'Type assertions in general are allowed.']) {
  const s=snapshotRules([{...rules.rules[0],content}]);
  const a=await auditFile({...input,content:'var f = (x) => x as string;'},s,async()=>ai('PASS'));
  assert.equal(a.violations.length,0);assert.equal(a.coverage[0].status,'UNCERTAIN');assert.equal(a.complete,false);
 }
});
test('exact TypeScript no-var rule has explicit non-TypeScript scope; unsupported prose does not',async()=>{
 const i={...input,file:'README.md',content:'var example'};
 const a=await auditFile(i,rules,async()=>ai('PASS'));
 assert.equal(a.coverage[0].status,'NOT_APPLICABLE');
 const s=snapshotRules([{...rules.rules[0],content:'Ensure architecture is secure.'}]);
 assert.equal((await auditFile(i,s,async()=>ai('PASS'))).coverage[0].status,'UNCERTAIN');
});
