import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root=process.cwd();
const files=["worker.js","pages/functions/_worker.js","installer/proxy-worker.js"];
for(const f of files){const p=path.join(root,f);if(!fs.existsSync(p))throw new Error("missing "+f);execFileSync(process.execPath,["--check",p],{stdio:"inherit"});}
const w=fs.readFileSync(path.join(root,"worker.js"),"utf8");
for(const x of ["export default","IOT_DB","__ADMIN_ROUTE__","__MASTER_KEY__","CREATE TABLE IF NOT EXISTS","cfnew-ipdb","bpb.yousef.isegaro.com","2a02:898:146:64::","/sub/","/ws/"])if(!w.includes(x))throw new Error("missing marker "+x);
const i=fs.readFileSync(path.join(root,"installer/index.html"),"utf8");
for(const x of ["Cloudflare API Token","d1/database","IOT_DB","workers/scripts"])if(!i.includes(x))throw new Error("installer missing "+x);
console.log("CloudIP static check: OK");
