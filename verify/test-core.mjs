// Portable targeted checks for installations without the optional Python executable.
// npm test additionally exercises Python extraction; this command does not certify it.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const files=pkg.scripts.test.split(' ').filter(s=>s.startsWith('tests/')&&!s.includes('python-resolution'));
const result=spawnSync(process.execPath,['--test','--test-concurrency=2','--test-skip-pattern=Python',...files],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;

