import React from "react";
import { createRoot } from "react-dom/client";
import { ProcedureChargeList } from "../../../ui/src/components/charting/ProcedureChargeList";
createRoot(document.getElementById("root")!).render(
  <ProcedureChargeList encounterId={new URLSearchParams(location.search).get("encounter")!} />,
);
