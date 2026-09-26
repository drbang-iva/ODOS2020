import { randomUUID } from "node:crypto";
import type { Task } from "@medplum/fhirtypes";
import { buildOdosAuditEventRow, type OdosAuditEventRecord } from "../../authz/odosAudit.js";
import { assertLabTransportState, canTransitionLabTransportState, isTerminalLabTransportState, labTransportStateConcept, type LabTransportState } from "../../fhir/labTransportState.js";
import { labOrderToExport } from "../../fhir/opticalLabOrder.js";
import { withLabOrderStatusRecord } from "../../fhir/labOrderStatus.js";
import { assertVisionWebTransmission, visionWebLabAccount, type VisionWebConfig } from "../../integrations/visionweb/config.js";
import { labOrderToVwOrder } from "../../integrations/visionweb/vwOrderSerializer.js";
import { sanitizeVendorText, visionWebSecrets, type VisionWebClient } from "../../integrations/visionweb/visionWebClient.js";
import { VISIONWEB_UNREADABLE, type VisionWebUploadResult } from "../../integrations/visionweb/uploadResponse.js";
import { assertStaffReference, taskIdFromReference, findActiveTransmissions } from "../lab-transmission-helpers.js";
import type { LabOrderAdapter } from "../lab-order-adapter.js";
import { isLabOrderTransmissionTask, transportStateFromTask, taskStatusForLabTransportState, ODOS_LAB_ORDER_TASK_CODE_SYSTEM, LAB_ORDER_TRANSMISSION_TASK_CODE, ODOS_LAB_ORDER_TASK_INPUT_SYSTEM, LAB_ORDER_EXPORT_INPUT_CODE, type LabOrderFhirClient } from "./manual-lab-order-adapter.js";
export const VISIONWEB_ORDER_ID_SYSTEM="https://odos2020.com/fhir/NamingSystem/visionweb-order-id";
export const VISIONWEB_UPLOAD_STATE_SYSTEM="https://odos2020.com/fhir/CodeSystem/visionweb-upload-state";
const UNKNOWN="VisionWeb outcome is unknown — confirm in VisionWeb before this order can be cleared.";
type UploadState="pending"|"uploading"|"accepted"|"review"|"rejected"|"unknown";
function uploadState(task:Task):UploadState {
  const values=task.statusReason?.coding?.filter(c=>c.system===VISIONWEB_UPLOAD_STATE_SYSTEM)??[];
  const code=values.length===1?values[0].code:undefined;
  return ["pending","uploading","accepted","review","rejected","unknown"].includes(code??"")?code as UploadState:"unknown";
}
function reason(state:UploadState) {return {coding:[{system:VISIONWEB_UPLOAD_STATE_SYSTEM,code:state}]};}
function assertVisionWebTask(task:Task,reference:string) {
  if (!isLabOrderTransmissionTask(task) || !task.identifier?.some(i=>i.system===VISIONWEB_ORDER_ID_SYSTEM && i.value)) throw new Error(`${reference} is not a VisionWeb lab transmission Task.`);
}
function safeUploadFailure(error:unknown):string {
  const message=error instanceof Error?error.message:"";
  return message===VISIONWEB_UNREADABLE || /^VisionWeb upload failed(?: with HTTP [1-5]\d\d)?\.$/.test(message)?message:"VisionWeb upload failed.";
}
export function createVisionWebLabOrderAdapter(fhir:LabOrderFhirClient,config:VisionWebConfig,client:VisionWebClient,options:{now?:()=>string;recordAudit?: (row:OdosAuditEventRecord)=>Promise<void>}):LabOrderAdapter {
  if(!options?.recordAudit)throw new Error("VisionWeb lab-order adapter recordAudit is required.");
  const recordAudit=options.recordAudit;const now=options.now??(()=>new Date().toISOString());
  async function audit(eventType:"create"|"update",staffReference:string,task:Task,actionReason:string){
    await recordAudit(buildOdosAuditEventRow({eventType,eventTime:now(),actorReference:staffReference,targetReference:`Task/${task.id}`,actionOutcome:"granted",actionReason}));
  }
  async function read(reference:string){const task=await fhir.read<Task>("Task",taskIdFromReference(reference,"labOrderReference"));assertVisionWebTask(task,reference);return task;}
  async function write(task:Task,state:LabTransportState,upload:UploadState,note?:string):Promise<Task>{
    return fhir.update<Task>("Task",task.id!,{...task,status:taskStatusForLabTransportState(state),businessStatus:labTransportStateConcept(state),statusReason:reason(upload),lastModified:now(),...(note?{note:[...(task.note??[]),{text:note,time:now()}]}:{})});
  }
  return {
    vendorId:"visionweb",name:"VisionWeb",vendorApiRequired:true,
    async submit(req){
      assertVisionWebTransmission(config);
      const account=visionWebLabAccount(config,req.lab);
      const orderId=taskIdFromReference(req.orderTaskReference,"orderTaskReference");assertStaffReference(req.staffReference);
      const xml=labOrderToVwOrder(req.order,account,{username:config.username,password:config.password});
      const exported=labOrderToExport(req.order);
      const clinical=await fhir.read<Task>("Task",orderId);
      if(isLabOrderTransmissionTask(clinical))assertVisionWebTask(clinical,req.orderTaskReference);
      if((await findActiveTransmissions(fhir,req.orderTaskReference)).length)throw new Error(`${req.orderTaskReference} is already transmitted through an active lab transmission Task.`);
      const at=now();const board=req.order.frameSource===0||req.order.frameSource===1?"at-lab":"in-office-not-sent";
      let task=await fhir.create<Task>(withLabOrderStatusRecord({resourceType:"Task",status:taskStatusForLabTransportState("queued"),intent:"order",code:{coding:[{system:ODOS_LAB_ORDER_TASK_CODE_SYSTEM,code:LAB_ORDER_TRANSMISSION_TASK_CODE,display:"Lab Order Transmission"}],text:"Lab Order Transmission"},businessStatus:labTransportStateConcept("queued"),statusReason:reason("pending"),identifier:[{system:VISIONWEB_ORDER_ID_SYSTEM,value:req.order.header.orderId}],basedOn:[{reference:req.orderTaskReference}],...(clinical.for?{for:clinical.for}:{}),description:`VisionWeb lab order to ${req.lab.trim()}`,authoredOn:at,lastModified:at,note:[{text:"VisionWeb upload pending.",time:at}],input:[{type:{coding:[{system:ODOS_LAB_ORDER_TASK_INPUT_SYSTEM,code:LAB_ORDER_EXPORT_INPUT_CODE,display:"Lab Order Export"}],text:"Lab Order Export"},valueString:JSON.stringify(exported)}]}, {version:1,currentStatus:board,history:[{status:board,enteredAt:at,setBy:req.staffReference}],problemFlags:[]}));
      if(!task.id)throw new Error("FHIR create returned a lab transmission Task without an id.");
      await audit("create",req.staffReference,task,`lab-order.submit:visionweb:${req.lab.trim()}:pending`);
      task=await write(task,"queued","uploading");
      let result:VisionWebUploadResult;
      try {
        result=await client.uploadOrder(config,{vwOrderXml:xml,subordid:req.order.header.orderId,msgguid:randomUUID(),sloid:account.supplierId});
        if(result.orderId!==req.order.header.orderId||result.supplierId!==account.supplierId)throw new Error(VISIONWEB_UNREADABLE);
      } catch(error) {
        try{task=await write(task,"queued","unknown","VisionWeb outcome unknown — confirm in VisionWeb before anything else is done with this order.");}catch{}
        try{await audit("update",req.staffReference,task,"lab-order.visionweb:outcome-unknown");}catch{}
        throw new Error(safeUploadFailure(error));
      }
      const detail=sanitizeVendorText(result.errorList??"",visionWebSecrets(config));
      const identifiers=[...(task.identifier??[])];
      if(result.vwebOrderId)identifiers.push({system:"https://odos2020.com/fhir/NamingSystem/visionweb-vweb-order-id",value:result.vwebOrderId});
      if(result.vwebExchangeId)identifiers.push({system:"https://odos2020.com/fhir/NamingSystem/visionweb-exchange-id",value:result.vwebExchangeId});
      task={...task,identifier:identifiers};
      const state=result.status==="Sent"?"sent":result.status==="Review"?"queued":"error";
      const uploaded=result.status==="Sent"?"accepted":result.status==="Review"?"review":"rejected";
      const note=result.status==="Sent"?"VisionWeb accepted the order.":result.status==="Review"?`VisionWeb review: ${detail}`:`VisionWeb rejected: ${detail}`;
      task=await write(task,state,uploaded,note);
      await audit("update",req.staffReference,task,result.status==="Review"?"lab-order.visionweb:review":`lab-order.transport:queued->${state}`);
      if(result.status==="Error")throw new Error(`VisionWeb rejected the order: ${detail}`);
      return {labOrderReference:`Task/${task.id}`,transportState:state,transmittedVia:"api",submittedAt:at};
    },
    async getTransportState(reference){return transportStateFromTask(await read(reference));},
    async advanceTransportState(req){
      assertStaffReference(req.staffReference);const task=await read(req.labOrderReference);const uploaded=uploadState(task);
      if(uploaded==="uploading"||uploaded==="unknown")throw new Error(UNKNOWN);
      if(uploaded==="pending"||uploaded==="rejected")throw new Error("VisionWeb never accepted this order — nothing to advance; use cancel().");
      if(req.toState==="cancelled")throw new Error("VisionWeb cancellation must use cancel().");
      assertLabTransportState(req.toState);const from=transportStateFromTask(task);
      if(!canTransitionLabTransportState(from,req.toState))throw new Error(`Cannot advance VisionWeb lab transport from "${from}" to "${req.toState}"; illegal transition.`);
      const updated=await write(task,req.toState,uploaded,req.note);await audit("update",req.staffReference,updated,`lab-order.transport:${from}->${req.toState}`);return req.toState;
    },
    async cancel(reference,staffReference){
      assertStaffReference(staffReference);const task=await read(reference);const uploaded=uploadState(task);
      if(uploaded==="uploading"||uploaded==="unknown")throw new Error(UNKNOWN);
      if(uploaded==="accepted"||uploaded==="review")throw new Error("VisionWeb has this order and has no cancel call — cancel it with the lab directly.");
      const from=transportStateFromTask(task);if(isTerminalLabTransportState(from))throw new Error(`Lab transport state "${from}" is terminal.`);
      const updated=await write(task,"cancelled",uploaded,"Cancelled in ODOS — VisionWeb never accepted this order.");await audit("update",staffReference,updated,`lab-order.transport:${from}->cancelled`);
    },
  };
}
