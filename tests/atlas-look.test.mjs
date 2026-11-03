import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','dist');
const src=f=>fs.readFileSync(path.join(dist,f),'utf8');
globalThis.localStorage=globalThis.localStorage||{getItem:()=>null,setItem:()=>{}};
const {migrateSettings,SETTINGS_VERSION,OBS_DEFAULTS}=await import('../dist/graph-panel.js');
const {DISPLAY_DEFAULTS}=await import('../dist/graph.js');

test('look settings left by an older version go back to the approved defaults once; content choices are kept',()=>{
 const stuck={v:3,display:{linkTint:false,glow:false,colorBy:'none',linkThickness:5,nodeSize:.1,palette:'Ember'},obs:{center:0,repel:20,link:1,distance:30},tags:true,existing:false,customGroups:[{q:'x'}],cluster:true,motionOverride:true,local:{on:true}};
 const m=migrateSettings(stuck);
 assert.equal(m.v,SETTINGS_VERSION);
 assert.equal(m.display,undefined,'stored display look dropped');assert.equal(m.obs,undefined,'stored forces and sizes dropped');
 // 2 Nov 2026: Tags is no longer kept (a saved Tags=on crushed the organic map); it returns to the approved default, off.
 assert.deepEqual([m.tags,m.existing,m.cluster,m.motionOverride,m.local.on,m.customGroups.length],[undefined,false,true,true,true,1]);
 const fresh={v:SETTINGS_VERSION,display:{linkTint:false},obs:{center:.3}};
 assert.equal(migrateSettings(fresh),fresh,'a version-4 choice made after this change is kept');
 for(const bad of [null,undefined,'x',5,[]])assert.deepEqual(migrateSettings(bad),{});
 assert.deepEqual(migrateSettings({display:{linkTint:false}}),{v:SETTINGS_VERSION},'an unversioned old save loses its look settings');
});
test('the approved defaults are what a clean browser gets: constellation, folder colours, tinted links, glow, owner\'s sizes',()=>{
 assert.equal(DISPLAY_DEFAULTS.linkTint,true);assert.equal(DISPLAY_DEFAULTS.glow,true);assert.equal(DISPLAY_DEFAULTS.colorBy,'folder');assert.equal(DISPLAY_DEFAULTS.palette,'Spectrum');assert.equal(DISPLAY_DEFAULTS.ring,true);
 assert.deepEqual({...OBS_DEFAULTS},{textFade:-1,nodeSize:1.22,linkThickness:2.93,center:.46,repel:11.23,link:.24,distance:254});
 assert.match(src('bigatlas.js'),/linkTint:true,glow:true/);
 assert.match(src('app.js'),/el\('button','View: constellation'\)/);
 assert.doesNotMatch(src('app.js'),/graph\.structural=true|big\.structural=true(?!\s*[;:]\s*false)/,'nothing starts the atlas in structure view');
});
test('Reset look is on the Atlas rail and clears structure view, cell view and the stored look',()=>{
 const app=src('app.js');
 assert.match(app,/Reset look/);assert.match(app,/tools\.append\(full,cellView,timeMap,rendering,labels,edges\)/);assert.match(app,/resetRow\.append\(resetLook\);tools\.append\(resetRow\)/);
 assert.match(app,/resetLook\.onclick=.*graph\.structural=false.*big\.structural=false.*graph\.cell\(\).*gp-reset/s);
});

test('Reset look presses the full settings reset, not Unpin all (1 Nov 2026)',async()=>{
 const fs=await import('node:fs/promises');
 const app=await fs.readFile(new URL('../dist/app.js',import.meta.url),'utf8'),panel=await fs.readFile(new URL('../dist/graph-panel.js',import.meta.url),'utf8');
 assert.match(app,/resetLook\.onclick=.*querySelector\('\.gp-reset-all'\)/s);
 assert.match(panel,/el\('button','Reset graph settings','gp-reset gp-reset-all'\)/);
 assert.doesNotMatch(panel,/el\('button','Unpin all','[^']*gp-reset-all/);
 assert.ok(SETTINGS_VERSION>=5,'saved look settings from before the fix go back to the approved defaults once');
});

test('Reset turns the local graph off and reloads the whole map (1 Nov 2026)',async()=>{
 const fs=await import('node:fs/promises');const panel=await fs.readFile(new URL('../dist/graph-panel.js',import.meta.url),'utf8');
 assert.match(panel,/reset\.onclick=\(\)=>\{if\(settings\.tags\)\{settings\.tags=false;state\.tags='';switches\.get\('Tags'\)\?\.\(false\);persist\(\);loadGraph\(\);\}if\(settings\.local\.on\)\{settings\.local\.on=false;syncLocal\(\);persist\(\);loadGraph\(\);\}/);
});
