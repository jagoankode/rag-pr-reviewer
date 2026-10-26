import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotRules } from '../src/core/review-rules.js';
import { auditFile, deterministicAudit, forbiddenKeywords, parseAICoverage, summarizeAudit } from '../src/core/review-engine.js';
import { ReviewInput, captureReviewInputs } from '../src/core/review-input.js';
import { parseAnnotatedDiffFiles } from '../src/core/diff-parser.js';
import { buildHybridPrompt } from '../src/core/review-prompt.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const rule = (content: string, id = 'typing') => ({ id, title: id, content, source: 'team', status: 'ACTIVE' });
const typing = rule('Forbidden types and patterns:\n - `any`\n - `unknown`\n - non-null assertion operator `!`\n - type assertions in general (`as Type`)\n\nExplicit parameter and return types are **mandatory** in every function signature');
const input = (content: string, extra: Partial<ReviewInput> = {}): ReviewInput => ({ file: 'src/a.ts', content, folderFiles: [], addedLines: [1], diff: '', scope: 'full', hash: '', ...extra });
const snap = snapshotRules([typing]);
const response = (status = 'PASS', violations: any[] = []) => JSON.stringify({ coverage: [{ ruleId: 'typing', status, reason: 'Checked remaining clauses', violations }] });
test('snapshot exhaustive sorted frozen, filters inactive/system without inventing rules', () => {
 const s = snapshotRules([rule('x','z'), {...rule('x','off'),status:'DISABLED'}, {...rule('x','sys'),source:'system-prompt'}, rule('x','a')]);
 assert.deepEqual(s.rules.map(r=>r.id),['a','z']); assert.ok(Object.isFrozen(s.rules[0]));
 assert.equal(s.hash,snapshotRules([...s.rules].reverse()).hash);
 assert.throws(()=>snapshotRules([typing,typing]));
 assert.equal(snapshotRules(Array.from({length:600},(_,i)=>rule('x',String(i)))).rules.length,600);
});
test('AST exact repeated identities incl same-line columns, no comments/string matches', () => {
 const i = input('// any unknown as X !\nconst s = "any unknown";\nlet a: any; let b: any; let c: unknown;\nconst f = (p) => p as string;');
 const first = deterministicAudit(i,snap);
 assert.equal(first.filter(v=>v.check==='forbidden-type').length,3);
 assert.equal(new Set(first.map(v=>v.id)).size,first.length);
 assert.ok(first.every(v=>v.line>=3));
 for(let n=0;n<30;n++) assert.deepEqual(deterministicAudit(i,snap),first);
 assert.equal(deterministicAudit(i,snapshotRules([])).length,0);
});
test('unknown is banned only explicitly, never inferred from example or Record', () => {
 assert.deepEqual(forbiddenKeywords(rule('Forbidden types and patterns:\n - `any`\n - open-ended `Record<string, unknown>`\n\n```ts\nlet x: unknown;\n```')),['any']);
 assert.ok(forbiddenKeywords(typing).includes('unknown'));
});
test('diff excludes preexisting lines and AST parse recovery is not reported',()=>{
 assert.equal(deterministicAudit(input('let x: any;\nlet y: any;', {scope:'diff',addedLines:[2]}),snap)[0].line,2);
 assert.deepEqual(deterministicAudit(input('let x: any = ('),snap),[]);
});
const scaffold = snapshotRules([rule('Every feature module **MUST** contain the files marked `[REQUIRED]`.\n```none\nModuleName.container.tsx // [REQUIRED]\nModuleName.component.tsx // [REQUIRED]\nModuleName.component.snap.test.{ts,tsx} // [REQUIRED]\nModuleName.hook.test.{ts,tsx} // [REQUIRED if hook exists]\n```','scaffold')]);
test('scaffold grounded required/conditional files, accepted test extensions, module boundaries',()=>{
 const i=input('',{file:'src/modules/Card/Card.component.tsx',folderFiles:['Card.component.tsx','Card.component.snap.test.ts']});
 assert.deepEqual(deterministicAudit(i,scaffold).map(v=>v.check),['missing:Card.container.tsx']);
 assert.equal(deterministicAudit({...i,folderFiles:[...i.folderFiles,'Card.hook.ts']},scaffold).length,2);
 assert.equal(deterministicAudit({...i,file:'src/modules/Card/sub/Card.component.tsx'},scaffold).length,0);
 assert.equal(deterministicAudit({...i,folderFiles:['Card.helpers.ts']},scaffold).length,0);
 assert.equal(deterministicAudit({...i,scope:'diff',addedLines:[2]},scaffold).length,0);
 assert.equal(deterministicAudit({...i,folderFiles:[...i.folderFiles,'Card.container.tsx','extra.ts']},scaffold).length,0);
});
test('typing applies to TS tests; generated snapshots do not parse as TS',()=>{
 assert.equal(deterministicAudit(input('let a: any;',{file:'src/a.test.ts'}),snap).length,1);
 assert.equal(deterministicAudit(input('let a: any;',{file:'src/__snapshots__/a.snap'}),snap).length,0);
});
test('naming uses declarations not strings',()=>{
 const s=snapshotRules([rule('**Classes / Types / Interfaces / Components** → `PascalCase`','naming')]);
 assert.equal(deterministicAudit(input('type bad_name = string; const text = "class bad {}";'),s).length,1);
});
test('AI missing/truncated/duplicate/unknown/invalid statuses never clean',()=>{
 for(const raw of ['{}','{"coverage":[',response('MAYBE'),JSON.stringify({coverage:[{ruleId:'not-a-rule'}]}),JSON.stringify({coverage:[...JSON.parse(response()).coverage,...JSON.parse(response()).coverage]})]) {
 const a=parseAICoverage(raw,input('let x = 1'),snap); assert.equal(a.complete,false);
 }
});
test('AI validates file line column scope and status consistency',()=>{
 const v={file:'src/a.ts',line:1,column:1,severity:'error',comment:'Evidence'};
 assert.equal(parseAICoverage(response('FAIL',[v]),input('abc'),snap).violations.length,1);
 for(const bad of [{...v,file:'../other'},{...v,line:0},{...v,line:2},{...v,column:9},{...v,severity:'fatal'}]) assert.equal(parseAICoverage(response('FAIL',[bad]),input('abc'),snap).complete,false);
 assert.equal(parseAICoverage(response('PASS',[v]),input('abc'),snap).complete,false);
 assert.equal(parseAICoverage(response('FAIL',[]),input('abc'),snap).complete,false);
 assert.equal(parseAICoverage(response('FAIL',[v]),input('abc',{scope:'diff',addedLines:[]}),snap).complete,false);
});
test('residual AI required, outages and uncertain results preserve deterministic findings',async()=>{
 for(const raw of ['{}',response('PASS')]) {
 const a=await auditFile(input('let x: any;'),snap,async()=>raw);
 assert.equal(a.violations.length,1);assert.equal(summarizeAudit([a],snap).status,'REQUEST_CHANGES');
 }
 const a=await auditFile(input('const x=1'),snap,async()=>{throw Error('offline')});
 assert.equal(summarizeAudit([a],snap).status,'APPROVE');
 const clean=await auditFile(input('const x=1'),snap,async()=>response());assert.equal(summarizeAudit([clean],snap).status,'APPROVE');
 assert.equal(summarizeAudit([],snapshotRules([])).status,'COMMENT');
});
test('dedup AI repeat at deterministic location, keep distinct AST columns',async()=>{
 const i=input('let a: any; let b: any;');const d=deterministicAudit(i,snap);
 const a=await auditFile(i,snap,async()=>response('FAIL',[{...d[0],comment:'duplicate'}]));
 assert.deepEqual(a.violations,d);
});
test('single-pass prompt interpolation cannot substitute placeholders inside code',()=>{
 assert.ok(buildHybridPrompt(input('const x="{{RULES}}"'),snap,[]).includes('const x="{{RULES}}"'));
});
test('capture staged and source branch content rather than unrelated worktree; freeze inventory',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumio-review-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'});
 try{
 git('init','-q');git('config','user.email','test@example.invalid');git('config','user.name','Test');
 fs.writeFileSync(path.join(dir,'a.ts'),'const a = 1;\n');git('add','.');git('commit','-qm','base');
 const base=git('rev-parse','HEAD').trim();
 fs.writeFileSync(path.join(dir,'a.ts'),'let a: any;\n');git('add','.');
 const diffs=parseAnnotatedDiffFiles(git('diff','--staged'));
 fs.writeFileSync(path.join(dir,'a.ts'),'worktree');
 const staged=captureReviewInputs(diffs,{staged:true},dir);assert.equal(staged[0].content,'let a: any;\n');
 git('commit','-qm','source');const source=git('rev-parse','HEAD').trim();
 const branch=captureReviewInputs(diffs,{source,target:base},dir);assert.equal(branch[0].content,staged[0].content);
 fs.writeFileSync(path.join(dir,'b.ts'),'later');assert.deepEqual(branch[0].folderFiles,['a.ts']);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('parse errors and unreadable inputs cannot get AI clean verdict',async()=>{
 for(const i of [input('let a = ('),input('',{error:'Unreadable'})]) {
 const a=await auditFile(i,snap,async()=>response());assert.equal(a.complete,false);
 }
});

test('module missing companions use canonical source location, dedup across files retains per-file failures',async()=>{
 const files=['Card.container.tsx','Card.component.tsx','Card.hook.ts'];
 const audits=await Promise.all(files.map(file=>auditFile(input('',{file:`src/modules/Card/${file}`,folderFiles:files}),scaffold,async()=> '{}')));
 const report=summarizeAudit(audits,scaffold);
 assert.equal(report.violations.length,2);
 assert.ok(report.violations.every(v=>v.file==='src/modules/Card/Card.component.tsx'));
 assert.equal(report.coverage?.filter(c=>c.status==='FAIL').length,3);
 assert.deepEqual(summarizeAudit([...audits].reverse(),scaffold).violations,report.violations);
});
