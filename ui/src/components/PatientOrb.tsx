import { Html, Sphere } from "@react-three/drei";
import type { Patient } from "@medplum/fhirtypes";

export function PatientOrb({ patient }: { patient: Patient }) {
  const name = patient.name?.[0];
  const display = name ? `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim() : "Patient";
  return (
    <group>
      <Sphere args={[0.9, 64, 64]}>
        <meshStandardMaterial color="#1a1d2e" emissive="#60a5fa" emissiveIntensity={0.4} roughness={0.3} metalness={0.6} />
      </Sphere>
      <Html position={[0, -1.4, 0]} center distanceFactor={8} style={{ pointerEvents: "none" }}>
        <div className="text-white/90 text-center whitespace-nowrap">
          <div className="text-sm font-semibold">{display}</div>
          {patient.birthDate && (
            <div className="text-xs text-white/50">DOB {patient.birthDate}</div>
          )}
        </div>
      </Html>
    </group>
  );
}
