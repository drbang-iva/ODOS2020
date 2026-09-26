import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task, Bundle } from "@medplum/fhirtypes";
import { findActiveTransmissions, taskIdFromReference, assertStaffReference } from "../src/lab-orders/lab-transmission-helpers.js";
import { labTransportStateConcept } from "../src/fhir/labTransportState.js";
import { ODOS_LAB_ORDER_TASK_CODE_SYSTEM,LAB_ORDER_TRANSMISSION_TASK_CODE } from "../src/lab-orders/adapters/manual-lab-order-adapter.js";
const task=(state:string,ref="Task/order"):Task=>({resourceType:"Task",status:"requested",intent:"order",code:{coding:[{system:ODOS_LAB_ORDER_TASK_CODE_SYSTEM,code:LAB_ORDER_TRANSMISSION_TASK_CODE}]},basedOn:[{reference:ref}],businessStatus:labTransportStateConcept(state)});
test("V17 active transmissions enforce type, reference, terminal state and one-page boundary", async()=>{
  const active=task("queued"); const failed=task("error"); const unrelated={...task("sent"),code:undefined};
  const bundle:Bundle<Task>={resourceType:"Bundle",type:"searchset",entry:[active,failed,task("cancelled"),task("received"),task("sent","Task/other"),unrelated].map(resource=>({resource}))};
  const fhir={search:async()=>bundle} as any;
  assert.deepEqual(await findActiveTransmissions(fhir,"Task/order"),[active,failed]);
  bundle.link=[{relation:"next",url:"https://example.test/next"}];
  await assert.rejects(findActiveTransmissions(fhir,"Task/order"),/exceeded one FHIR page/);
  assert.equal(taskIdFromReference("Task/order","order"),"order");
  assert.throws(()=>taskIdFromReference("https://other/Task/x","order"));
  assert.doesNotThrow(()=>assertStaffReference("Practitioner/test")); assert.throws(()=>assertStaffReference("Patient/test"));
});
