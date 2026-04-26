/**
 * PatientDirector — Variant A of the Director UI.
 *
 * Central orb = patient. Six orbital systems around it:
 *   Anterior Segment, Refractive, Systemic, Posterior Segment,
 *   Retina, Lids/Adnexa.
 *
 * v0.2 scope: placeholder orbital geometry + hover states + zoom scaffolding.
 * Next: wire each orbital to FHIR search (Observations with anatomical-location tags).
 */

import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stars, Float } from "@react-three/drei";
import { Suspense, useState } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { PatientOrb } from "../components/PatientOrb";
import { Orbital } from "../components/Orbital";
import { OrbitalDetail } from "../components/OrbitalDetail";
import { Hud } from "../components/Hud";
import { ChartSidebar } from "../components/ChartSidebar";
import { useRole } from "../lib/role-context";
import type { OrbitalId } from "../types/orbital";

const ORBITAL_SYSTEMS: Array<{
  id: OrbitalId;
  label: string;
  angle: number;
  radius: number;
  color: string;
}> = [
  { id: "anterior-segment", label: "Anterior Segment", angle: 90,  radius: 4, color: "#60a5fa" },
  { id: "refractive",       label: "Refractive",       angle: 30,  radius: 4, color: "#6ee7b7" },
  { id: "systemic",         label: "Systemic",         angle: -30, radius: 4, color: "#fbbf24" },
  { id: "posterior-segment",label: "Posterior Segment",angle: -90, radius: 4, color: "#f59e0b" },
  { id: "retina",           label: "Retina",           angle: -150,radius: 4, color: "#c084fc" },
  { id: "lids-adnexa",      label: "Lids / Adnexa",    angle: 150, radius: 4, color: "#f472b6" },
];

function polar(angleDeg: number, radius: number): [number, number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [Math.cos(rad) * radius, Math.sin(rad) * radius, 0];
}

export function PatientDirector({ patient }: { patient: Patient }) {
  const [selected, setSelected] = useState<OrbitalId | null>(null);
  const { config } = useRole();
  const orbitalSystems = ORBITAL_SYSTEMS.filter((system) =>
    config.directorOrbitalFilters.includes(system.id),
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-deep lg:flex-row">
      <div className="relative min-h-[520px] min-w-0 flex-1 lg:min-h-0">
        <Hud patient={patient} selected={selected} onClearSelection={() => setSelected(null)} />

        <Canvas camera={{ position: [0, 0, 10], fov: 50 }}>
          <Suspense fallback={null}>
            <color attach="background" args={["#0a0b14"]} />
            <ambientLight intensity={0.4} />
            <pointLight position={[10, 10, 10]} intensity={1.5} />
            <Stars radius={100} depth={50} count={2000} factor={3} fade speed={0.5} />

            <Float floatIntensity={0.3} speed={1.5}>
              <PatientOrb patient={patient} />
            </Float>

            {orbitalSystems.map((s) => (
              <Orbital
                key={s.id}
                position={polar(s.angle, s.radius)}
                label={s.label}
                color={s.color}
                selected={selected === s.id}
                onSelect={() => setSelected(s.id)}
              />
            ))}

            <OrbitControls
              enablePan={false}
              minDistance={6}
              maxDistance={20}
              minPolarAngle={Math.PI / 3}
              maxPolarAngle={(2 * Math.PI) / 3}
            />
          </Suspense>
        </Canvas>

        {selected && (
          <OrbitalDetail orbitalId={selected} patient={patient} onClose={() => setSelected(null)} />
        )}
      </div>
      <ChartSidebar patient={patient} />
    </div>
  );
}
