import { Html, Sphere } from "@react-three/drei";
import { useState } from "react";

interface Props {
  position: [number, number, number];
  label: string;
  color: string;
  selected: boolean;
  onSelect: () => void;
}

export function Orbital({ position, label, color, selected, onSelect }: Props) {
  const [hovered, setHovered] = useState(false);

  return (
    <group position={position}>
      <Sphere
        args={[selected ? 0.7 : hovered ? 0.55 : 0.45, 32, 32]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={hovered || selected ? 0.8 : 0.3}
          roughness={0.4}
        />
      </Sphere>
      <Html position={[0, -0.9, 0]} center distanceFactor={10} style={{ pointerEvents: "none" }}>
        <div
          className="text-xs whitespace-nowrap font-medium px-2 py-0.5 rounded"
          style={{
            color,
            textShadow: "0 0 8px rgba(0,0,0,0.8)",
            opacity: hovered || selected ? 1 : 0.75,
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}
