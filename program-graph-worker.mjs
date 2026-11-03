// WRONGLOOK1 (owner 22:07, the graph never loads): builds the program islands for the whole-vault map off the door's main thread.
// The door asks for one build, this worker reads the program ledgers, capabilities and orbs from the data folder, answers once, and ends.
import {parentPort,workerData} from 'node:worker_threads';
import {ProgramCapture} from './programs.mjs';
const {vault,dataRoot,programsRoot,manifestFile}=workerData;
try{
 const capture=new ProgramCapture({vault,dataRoot,programsRoot,manifestFile});
 capture.reload();
 const started=Date.now(),graph=capture.enabled?capture.graph():null;
 parentPort.postMessage({ok:true,graph,ms:Date.now()-started});
}catch(error){parentPort.postMessage({ok:false,error:String(error&&error.message||error)});}
