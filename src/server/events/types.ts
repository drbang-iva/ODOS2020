export interface DomainEvent {
  id: string;
  type: string;
  timestamp: string;
  practiceId: string;
  actorId: string;
  actorType: 'human' | 'local_agent' | 'cloud_agent';
  entityType: string;
  entityId: string;
  payload: unknown;
  correlationId: string;
  /** Snapshot of the entity before the change. NULL on create. */
  previousState?: Record<string, unknown> | object | null;
  /** Snapshot of the entity after the change. NULL on delete. */
  newState?: Record<string, unknown> | object | null;
}

// Phase 1 event types
export interface PatientCreatedEvent extends DomainEvent {
  type: 'patient.created';
  entityType: 'patient';
  payload: { firstName: string; lastName: string };
}

export interface PatientUpdatedEvent extends DomainEvent {
  type: 'patient.updated';
  entityType: 'patient';
  payload: { changes: Record<string, unknown> };
}

export interface PatientAlertCreatedEvent extends DomainEvent {
  type: 'patient.alert.created';
  entityType: 'patient_alert';
  payload: { alertType: string; severity: string; message: string };
}

export interface PatientAlertResolvedEvent extends DomainEvent {
  type: 'patient.alert.resolved';
  entityType: 'patient_alert';
  payload: { resolvedBy: string };
}

export interface PatientDeactivatedEvent extends DomainEvent {
  type: 'patient.deactivated';
  entityType: 'patient';
  payload: Record<string, never>;
}

export interface PatientInsuranceAddedEvent extends DomainEvent {
  type: 'patient.insurance.added';
  entityType: 'patient_insurance';
  payload: { patientId: string; priority: number; planType: string; payerName: string };
}

export interface PatientInsuranceUpdatedEvent extends DomainEvent {
  type: 'patient.insurance.updated';
  entityType: 'patient_insurance';
  payload: { patientId: string; changes: Record<string, unknown> };
}

export interface PatientInsuranceDeletedEvent extends DomainEvent {
  type: 'patient.insurance.deleted';
  entityType: 'patient_insurance';
  payload: { patientId: string };
}

export interface PatientResponsiblePartyAddedEvent extends DomainEvent {
  type: 'patient.responsible_party.added';
  entityType: 'responsible_party';
  payload: { patientId: string; relationship: string };
}

export interface PatientResponsiblePartyDeletedEvent extends DomainEvent {
  type: 'patient.responsible_party.deleted';
  entityType: 'responsible_party';
  payload: { patientId: string };
}

export interface AppointmentScheduledEvent extends DomainEvent {
  type: 'appointment.scheduled';
  entityType: 'appointment';
  payload: { patientId: string; providerId: string; startTime: string };
}

export interface AppointmentUpdatedEvent extends DomainEvent {
  type: 'appointment.updated';
  entityType: 'appointment';
  payload: { changes: Record<string, unknown> };
}

export interface AppointmentStatusChangedEvent extends DomainEvent {
  type: 'appointment.status_changed';
  entityType: 'appointment';
  payload: { oldStatus: string; newStatus: string };
}

export interface AppointmentCancelledEvent extends DomainEvent {
  type: 'appointment.cancelled';
  entityType: 'appointment';
  payload: { reason: string };
}

export interface EquipmentRegisteredEvent extends DomainEvent {
  type: 'equipment.registered';
  entityType: 'equipment';
  payload: { name: string; deviceCategory: string; integrationType: string };
}

export interface EquipmentUpdatedEvent extends DomainEvent {
  type: 'equipment.updated';
  entityType: 'equipment';
  payload: { changes: Record<string, unknown> };
}

export interface EquipmentDeactivatedEvent extends DomainEvent {
  type: 'equipment.deactivated';
  entityType: 'equipment';
  payload: Record<string, never>;
}

export interface DeviceReadingReceivedEvent extends DomainEvent {
  type: 'device.reading_received';
  entityType: 'device_reading';
  payload: { equipmentId: string; readingType: string };
}

export interface DeviceReadingMatchedEvent extends DomainEvent {
  type: 'device.reading_matched';
  entityType: 'device_reading';
  payload: { patientId: string; matchedBy: string };
}

export interface DeviceReadingReviewedEvent extends DomainEvent {
  type: 'device.reading_reviewed';
  entityType: 'device_reading';
  payload: { reviewedBy: string };
}

export type Phase1Event =
  | PatientCreatedEvent
  | PatientUpdatedEvent
  | PatientDeactivatedEvent
  | PatientAlertCreatedEvent
  | PatientAlertResolvedEvent
  | PatientInsuranceAddedEvent
  | PatientInsuranceUpdatedEvent
  | PatientInsuranceDeletedEvent
  | PatientResponsiblePartyAddedEvent
  | PatientResponsiblePartyDeletedEvent
  | AppointmentScheduledEvent
  | AppointmentUpdatedEvent
  | AppointmentStatusChangedEvent
  | AppointmentCancelledEvent
  | EquipmentRegisteredEvent
  | EquipmentUpdatedEvent
  | EquipmentDeactivatedEvent
  | DeviceReadingReceivedEvent
  | DeviceReadingMatchedEvent
  | DeviceReadingReviewedEvent;
