import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
// Resolve an immutable, successful quality run before touching the production host.
const [repo,sha]=process.argv.slice(2);
if(!/^[\w.-]+\/[\w.-]+$/.test(repo??'')||!/^[a-f0-9]{40}$/.test(sha??''))throw Error('Invalid release identity');
const api=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',maxBuffer:4*1024*1024}));
const runs=api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`).workflow_runs;
for(const run of runs){
 if(run.head_sha!==sha||run.head_branch!=='main'||run.conclusion!=='success'||!['push','workflow_dispatch'].includes(run.event)||run.head_repository?.full_name!==repo)continue;
 const artifacts=api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts;
 if(!artifacts.some(a=>a.name==='server-bundle'&&!a.expired&&Date.parse(a.expires_at)>Date.now()))continue;
 appendFileSync(process.env.GITHUB_ENV,`STREAM_PANEL_CI_RUN=${run.id}\nSTREAM_PANEL_RELEASE=${sha}\n`);process.exit(0);
}
throw Error(`No unexpired server-bundle from successful main CI for ${sha}. Rerun Quality gate on this exact main SHA, then retry deployment. No server changes were made.`);
