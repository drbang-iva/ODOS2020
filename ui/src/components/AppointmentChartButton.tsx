import { useEffect, useRef, useState } from "react";
import type { Appointment, Encounter } from "@medplum/fhirtypes";
import {
  findOpenEncounterForAppointment,
  startOrOpenEncounterForAppointment,
} from "../lib/encounter-bundles";
import { odosAppointmentStatusOf } from "../lib/scheduling";
import { openEncounter } from "../lib/view-state";

export function AppointmentChartButton({
  appointment,
  className = "scheduler-button",
  onError,
}: {
  appointment: Appointment;
  className?: string;
  onError?: (message: string | null) => void;
}) {
  const [existingEncounter, setExistingEncounter] = useState<Encounter | null>();
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const checkedIn = odosAppointmentStatusOf(appointment) === "checked-in";

  useEffect(() => {
    if (!checkedIn || !appointment.id) {
      setExistingEncounter(undefined);
      return;
    }
    let cancelled = false;
    setExistingEncounter(undefined);
    void findOpenEncounterForAppointment(appointment.id)
      .then((encounter) => {
        if (!cancelled) setExistingEncounter(encounter ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setExistingEncounter(undefined);
          onError?.(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appointment.id, checkedIn, onError]);

  if (!checkedIn) {
    return null;
  }

  async function openChart() {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    onError?.(null);
    try {
      const result = await startOrOpenEncounterForAppointment(appointment, {
        existingEncounter,
      });
      const patientReference = appointment.participant.find((participant) =>
        participant.actor?.reference?.startsWith("Patient/"),
      )?.actor?.reference;
      if (!patientReference) {
        throw new Error("Opening an appointment chart requires a patient participant.");
      }
      openEncounter(patientReference.slice("Patient/".length), result.encounterId);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }

  return (
    <button className={className} type="button" disabled={opening} onClick={() => void openChart()}>
      {opening ? "Opening chart…" : existingEncounter?.id ? "Open chart" : "Start chart"}
    </button>
  );
}
