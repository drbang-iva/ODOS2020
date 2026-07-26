import type { Application, Request, Response } from "express";
import type { PracticeRoleId } from "../authz/roles.js";
import {
  SchedulingResourceInputError,
  createSchedulingResource,
  deactivateSchedulingResource,
  inspectSchedulingIntegrity,
  listRenderableSchedulingResources,
  parseSchedulingResourceInput,
  updateSchedulingResource,
  type SchedulingResourceFhir,
} from "./scheduling-resource-service.js";

export interface SchedulingResourceStaff {
  roles: PracticeRoleId[];
}

export interface SchedulingResourceRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<SchedulingResourceStaff | null>;
  serviceFhir: SchedulingResourceFhir;
  now?: () => string;
}

export function registerSchedulingResourceRoutes(
  app: Application,
  deps: SchedulingResourceRouteDeps,
): void {
  app.get("/scheduling/resources", (req, res) =>
    route(deps, req, res, "read", async () => {
      const result = await listRenderableSchedulingResources(deps.serviceFhir);
      return { status: 200, body: result };
    }),
  );

  app.get("/scheduling/integrity", (req, res) =>
    route(deps, req, res, "admin", async () => ({
      status: 200,
      body: { issues: await inspectSchedulingIntegrity(deps.serviceFhir) },
    })),
  );

  app.post("/scheduling/resources", (req, res) =>
    route(deps, req, res, "admin", async () => ({
      status: 201,
      body: await createSchedulingResource(deps.serviceFhir, parseSchedulingResourceInput(req.body)),
    })),
  );

  app.post("/scheduling/resources/:scheduleId", (req, res) =>
    route(deps, req, res, "admin", async () => {
      if (
        !req.body ||
        typeof req.body !== "object" ||
        req.body.resourceType !== "Schedule" ||
        req.body.id !== req.params.scheduleId
      ) {
        throw new SchedulingResourceInputError(
          "Schedule update body must be the matching existing Schedule resource.",
        );
      }
      return {
        status: 200,
        body: await updateSchedulingResource(deps.serviceFhir, req.body),
      };
    }),
  );

  app.post("/scheduling/resources/:scheduleId/deactivate", (req, res) =>
    route(deps, req, res, "admin", async () => {
      const result = await deactivateSchedulingResource(deps.serviceFhir, req.params.scheduleId, {
        acknowledgeFutureAppointments:
          Boolean(req.body && typeof req.body === "object" && req.body.acknowledgeFutureAppointments === true),
        now: deps.now?.(),
      });
      return {
        status: result.deactivated ? 200 : 409,
        body: result.deactivated
          ? result
          : {
              ...result,
              error:
                `${result.futureAppointmentCount} future appointment${result.futureAppointmentCount === 1 ? "" : "s"} ` +
                "must be moved or explicitly acknowledged before deactivation.",
            },
      };
    }),
  );
}

async function route(
  deps: SchedulingResourceRouteDeps,
  req: Request,
  res: Response,
  access: "read" | "admin",
  operation: (staff: SchedulingResourceStaff) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required for scheduler resources." });
      return;
    }
    const allowed = staff.roles.includes("practice-admin")
      || (access === "read" && staff.roles.includes("front-desk"));
    if (!allowed) {
      res.status(403).json({
        error: access === "admin"
          ? "Practice admin role required for scheduler resource changes."
          : "Scheduler access required.",
      });
      return;
    }
    const result = await operation(staff);
    res.status(result.status).json(result.body);
  } catch (error) {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : "Scheduler resource request failed.";
    if (status >= 500) {
      console.error("odos-mcp: scheduler resource route failed:", error);
    }
    if (!res.headersSent) res.status(status).json({ error: message });
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof SchedulingResourceInputError) return 400;
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number(error.status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return 500;
}
