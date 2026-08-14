import { useEffect, useRef, useState } from "react";
import type { Appointment, Encounter } from "@medplum/fhirtypes";
import {
  findOpenEncounterForAppointment,
  startOrOpenEncounterForAppointment,
} from "../lib/encounter-bundles";
import { assignProviderForAppointment } from "../lib/clinical-graph-client";
import { fhir } from "../lib/fhir";
import { odosAppointmentStatusOf } from "../lib/scheduling";
import { openEncounter } from "../lib/view-state";

type AppointmentChartButtonProps = {
  className?: string;
  onError?: (message: string | null) => void;
} & (
  | {
      appointment: Appointment;
      appointmentId?: never;
      existingEncounterId?: never;
    }
  | {
      appointment?: never;
      appointmentId: string;
      existingEncounterId?: string;
    }
);

export function AppointmentChartButton(props: AppointmentChartButtonProps) {
  const {
    className = "scheduler-button",
    onError,
  } = props;
  const suppliedAppointment = props.appointment;
  const appointmentId = suppliedAppointment?.id ?? props.appointmentId;
  const [fetchedAppointment, setFetchedAppointment] = useState<Appointment | null>();
  const [existingEncounter, setExistingEncounter] = useState<Encounter | null>();
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const appointment = suppliedAppointment ?? fetchedAppointment ?? undefined;
  const checkedIn = appointment
    ? odosAppointmentStatusOf(appointment) === "checked-in"
    : props.appointmentId !== undefined && fetchedAppointment !== null;

  useEffect(() => {
    if (suppliedAppointment || !appointmentId) {
      setFetchedAppointment(undefined);
      return;
    }
    let cancelled = false;
    setFetchedAppointment(undefined);
    void fhir.read<Appointment>("Appointment", appointmentId)
      .then((value) => {
        if (!cancelled) setFetchedAppointment(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFetchedAppointment(null);
          onError?.(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId, onError, suppliedAppointment]);

  useEffect(() => {
    if (!checkedIn || !appointmentId) {
      setExistingEncounter(undefined);
      return;
    }
    let cancelled = false;
    setExistingEncounter(undefined);
    void findOpenEncounterForAppointment(appointmentId)
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
  }, [appointmentId, checkedIn, onError]);

  if (!checkedIn || fetchedAppointment === null) {
    return null;
  }

  async function openChart() {
    if (!appointment) return;
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    onError?.(null);
    try {
      if (!appointment.id) {
        throw new Error("Opening an appointment chart requires Appointment.id.");
      }
      await assignProviderForAppointment(appointment.id);
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
    <button className={className} type="button" disabled={opening || !appointment} onClick={() => void openChart()}>
      {opening
        ? "Opening chart…"
        : existingEncounter?.id || props.existingEncounterId
          ? "Open chart"
          : "Start chart"}
    </button>
  );
}
