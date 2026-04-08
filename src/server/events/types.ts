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

export interface AppointmentScheduledEvent extends DomainEvent {
  type: 'appointment.scheduled';
  entityType: 'appointment';
  payload: { patientId: string; providerId: string; startTime: string };
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
  | PatientAlertCreatedEvent
  | PatientAlertResolvedEvent
  | AppointmentScheduledEvent
  | AppointmentStatusChangedEvent
  | AppointmentCancelledEvent
  | DeviceReadingReceivedEvent
  | DeviceReadingMatchedEvent
  | DeviceReadingReviewedEvent;
