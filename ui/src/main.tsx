import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ConfirmDestructiveProvider } from "./components/charting/ConfirmDestructive";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfirmDestructiveProvider><App /></ConfirmDestructiveProvider>
  </React.StrictMode>,
);
