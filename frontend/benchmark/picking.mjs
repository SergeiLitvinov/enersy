import { build,version as esbuildVersion } from 'esbuild';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir,cpus } from 'node:os';
import { join,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const temporary=await mkdtemp(join(tmpdir(),'enersy-picking-'));
try {
  const entry=process.argv[3]??'picking.ts';
  if(!['picking.ts','drag-preview.ts','route-cache.ts','index-updates.ts','index-build.ts'].includes(entry))throw new Error('Unknown benchmark');
  const output=join(temporary,'profile.mjs');
  await build({entryPoints:[join(dirname(fileURLToPath(import.meta.url)),entry)],outfile:output,bundle:true,platform:'node',format:'esm'});
  const { profile }=await import(pathToFileURL(output).href);
  const result=await profile();
  result.hardware={cpu_model:cpus()[0]?.model??null};
  result.esbuild=esbuildVersion;
  const root=join(dirname(fileURLToPath(import.meta.url)),'..');
  result.source_sha256={};
  for(const path of ['src/domain/spatial-index.ts','src/domain/updatable-spatial-index.ts','src/domain/diagram-routing.ts','src/components/ees/editor-picking.ts',
    'src/components/ees/editor-geometry.ts','src/components/ees/editor-route-cache.ts','src/components/ees/editor-utils.ts',`benchmark/${entry}`,'benchmark/picking.mjs','package-lock.json']) {
    const source=(await readFile(join(root,path),'utf8')).replaceAll('\r\n','\n');
    result.source_sha256[path]=createHash('sha256').update(source).digest('hex');
  }
  result.container_limits={cpu_max:await readFile('/sys/fs/cgroup/cpu.max','utf8').catch(()=>null),
    memory_max:await readFile('/sys/fs/cgroup/memory.max','utf8').catch(()=>null)};
  if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally { await rm(temporary,{recursive:true,force:true}); }
