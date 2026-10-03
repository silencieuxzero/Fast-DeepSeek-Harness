import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const require = createRequire('C:/Users/rain/.dsh/profiles/node_modules/dsh-desktop-next/')
const yaml = require('yaml')
const { applyEntryPatches } = require('@deepseek-ai/cordis-plugin-include')
const WEBAPP='C:/Users/rain/.dsh/profiles/node_modules/dsh-desktop-next/node_modules/@deepseek-ai/dsh-web-app'
const P='C:/Users/rain/.dsh/profiles/desktop/cordis.patch.yml'
const load=p=>yaml.parse(readFileSync(p,'utf8').replace(/!!js /g,''))
const w=[]
const rows=applyEntryPatches([],[load(join(WEBAPP,'presets/standard.patch.yml')),load(P)].flat(),(m,...a)=>{let i=0;w.push(m.replace(/%C/g,()=>JSON.stringify(a[i++])))})
console.log('LIVE rows:',rows.map(r=>r.id).join(', '))
console.log('warnings:',w.length)
const bf=rows.find(r=>r.id==='preset-bash-first')
console.log('bash-first plugins:',(bf?.config?.plugins??[]).map(p=>p.id).join(', '))
const gate=(bf?.config?.plugins??[]).find(p=>p.id==='shell-fallback')
console.log('gate:',JSON.stringify(gate))
