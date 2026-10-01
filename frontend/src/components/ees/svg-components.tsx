function Winding({ cx, cy, r, n = 3, stroke, gap = 2 }: { cx: number; cy: number; r: number; n?: number; stroke: string; gap?: number }) {
  const arcs: string[] = [];
  const totalArc = 180 - gap * (n - 1);
  const arcAngle = totalArc / n;
  const startAngle = 180 + gap / 2;
  for (let i = 0; i < n; i++) {
    const a1 = ((startAngle + i * (arcAngle + gap)) * Math.PI) / 180;
    const a2 = ((startAngle + i * (arcAngle + gap) + arcAngle) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    arcs.push(`M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 0 ${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }
  return <path d={arcs.join(' ')} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />;
}

function WindingVertical({ cx, cy, r, n = 3, stroke, gap = 2 }: { cx: number; cy: number; r: number; n?: number; stroke: string; gap?: number }) {
  const arcs: string[] = [];
  const totalArc = 180 - gap * (n - 1);
  const arcAngle = totalArc / n;
  const startAngle = 90 + gap / 2;
  for (let i = 0; i < n; i++) {
    const a1 = ((startAngle + i * (arcAngle + gap)) * Math.PI) / 180;
    const a2 = ((startAngle + i * (arcAngle + gap) + arcAngle) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    arcs.push(`M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }
  return <path d={arcs.join(' ')} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />;
}

export const ComponentSVG: Record<string, React.FC<{ className?: string; w?: number; h?: number }>> = {

  // ===== ИСТОЧНИКИ | ГОСТ 2.722-68, СТО 56947007-29.240.10.249-2017 =====
  // Символ: окружность с обмоткой внутри (синхронная машина/ДГУ)
  generator: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="10" stroke="#2e7d32" strokeWidth="2" />
      <line x1="30" y1="58" x2="30" y2="50" stroke="#2e7d32" strokeWidth="2" />
      <circle cx="30" cy="30" r="20" fill="none" stroke="#2e7d32" strokeWidth="2" />
      <path d="M12 30 A18 18 0 0 1 30 12" fill="none" stroke="#2e7d32" strokeWidth="2" />
      <line x1="10" y1="30" x2="30" y2="30" stroke="#2e7d32" strokeWidth="2" />
    </g>
  ),

  // ===== ТРАНСФОРМАЦИЯ | ГОСТ 2.723-68 =====
  transformer: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="8" stroke="#ef6c00" strokeWidth="2" />
      <Winding cx={10} cy={24} r={14} stroke="#ef6c00" n={3} gap={3} />
      <Winding cx={50} cy={24} r={14} stroke="#ef6c00" n={3} gap={3} />
      <line x1="30" y1="36" x2="30" y2="44" stroke="#ef6c00" strokeWidth="1.5" strokeDasharray="4,2" />
      <Winding cx={10} cy={56} r={14} stroke="#ef6c00" n={3} gap={3} />
      <Winding cx={50} cy={56} r={14} stroke="#ef6c00" n={3} gap={3} />
      <line x1="30" y1="72" x2="30" y2="78" stroke="#ef6c00" strokeWidth="2" />
    </g>
  ),

  transformer_3w: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="6" stroke="#e65100" strokeWidth="2" />
      <WindingVertical cx={30} cy={18} r={11} stroke="#e65100" n={3} gap={3} />
      <line x1="30" y1="28" x2="30" y2="32" stroke="#e65100" strokeWidth="1.5" strokeDasharray="4,2" />
      <WindingVertical cx={30} cy={44} r={11} stroke="#e65100" n={3} gap={3} />
      <line x1="30" y1="54" x2="30" y2="58" stroke="#e65100" strokeWidth="1.5" strokeDasharray="4,2" />
      <WindingVertical cx={30} cy={70} r={11} stroke="#e65100" n={3} gap={3} />
      <line x1="30" y1="80" x2="30" y2="88" stroke="#e65100" strokeWidth="2" />
    </g>
  ),

  // Символ по СТО: ромб/шестиугольник с перекрестием на линии
  autotransformer: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="8" stroke="#00695c" strokeWidth="2" />
      <Winding cx={10} cy={24} r={12} stroke="#00695c" n={3} gap={3} />
      <Winding cx={50} cy={24} r={12} stroke="#00695c" n={3} gap={3} />
      <line x1="30" y1="26" x2="30" y2="54" stroke="#00695c" strokeWidth="2" />
      <Winding cx={10} cy={56} r={12} stroke="#00695c" n={3} gap={3} />
      <Winding cx={50} cy={56} r={12} stroke="#00695c" n={3} gap={3} />
      <line x1="30" y1="72" x2="30" y2="78" stroke="#00695c" strokeWidth="2" />
    </g>
  ),

  // ===== ЛИНИИ | ГОСТ 2.721-74 =====
  transmission_line: ({ className }) => (
    <g className={className}>
      <line x1="0" y1="15" x2="100" y2="15" stroke="#1976d2" strokeWidth="2" />
      <line x1="0" y1="25" x2="100" y2="25" stroke="#1976d2" strokeWidth="2" />
      <line x1="20" y1="8" x2="20" y2="15" stroke="#1976d2" strokeWidth="2" />
      <line x1="20" y1="25" x2="20" y2="32" stroke="#1976d2" strokeWidth="2" />
      <line x1="50" y1="6" x2="50" y2="15" stroke="#1976d2" strokeWidth="2" />
      <line x1="50" y1="25" x2="50" y2="34" stroke="#1976d2" strokeWidth="2" />
      <line x1="80" y1="8" x2="80" y2="15" stroke="#1976d2" strokeWidth="2" />
      <line x1="80" y1="25" x2="80" y2="32" stroke="#1976d2" strokeWidth="2" />
      <line x1="20" y1="6" x2="16" y2="3" stroke="#1976d2" strokeWidth="1.5" />
      <line x1="20" y1="6" x2="24" y2="3" stroke="#1976d2" strokeWidth="1.5" />
      <line x1="50" y1="34" x2="46" y2="37" stroke="#1976d2" strokeWidth="1.5" />
      <line x1="50" y1="34" x2="54" y2="37" stroke="#1976d2" strokeWidth="1.5" />
      <line x1="80" y1="6" x2="76" y2="3" stroke="#1976d2" strokeWidth="1.5" />
      <line x1="80" y1="6" x2="84" y2="3" stroke="#1976d2" strokeWidth="1.5" />
    </g>
  ),

  // ===== КОММУТАЦИЯ | ГОСТ 2.755-87, СТО 56947007-29.240.10.249-2017 =====
  // Символ по СТО: ромб/шестиугольник с перекрестием на линии
  breaker: ({ className }) => (
    <g className={className}>
      <line x1="25" y1="2" x2="25" y2="8" stroke="#c2185b" strokeWidth="2" />
      <line x1="25" y1="58" x2="25" y2="52" stroke="#c2185b" strokeWidth="2" />
      <line x1="5" y1="30" x2="45" y2="30" stroke="#c2185b" strokeWidth="2" />
      <line x1="25" y1="15" x2="45" y2="30" stroke="#c2185b" strokeWidth="2" />
      <line x1="45" y1="30" x2="25" y2="45" stroke="#c2185b" strokeWidth="2" />
      <line x1="25" y1="45" x2="5" y2="30" stroke="#c2185b" strokeWidth="2" />
      <line x1="5" y1="30" x2="25" y2="15" stroke="#c2185b" strokeWidth="2" />
    </g>
  ),

  // Разъединитель по ГОСТ 2.755-87
  disconnector: ({ className }) => (
    <g className={className}>
      <line x1="25" y1="2" x2="25" y2="12" stroke="#7b1fa2" strokeWidth="2" />
      <circle cx="25" cy="12" r="3" fill="#e1bee7" stroke="#7b1fa2" strokeWidth="2" />
      <line x1="25" y1="12" x2="42" y2="28" stroke="#7b1fa2" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="10" y1="34" x2="42" y2="34" stroke="#7b1fa2" strokeWidth="2" />
      <line x1="25" y1="34" x2="25" y2="50" stroke="#7b1fa2" strokeWidth="2" />
    </g>
  ),

  // Заземляющий нож по ГОСТ 2.755-87 + СТО
  grounding_switch: ({ className }) => (
    <g className={className}>
      <line x1="25" y1="2" x2="25" y2="12" stroke="#424242" strokeWidth="2" />
      <circle cx="25" cy="12" r="3" fill="#bdbdbd" stroke="#424242" strokeWidth="2" />
      <line x1="25" y1="12" x2="42" y2="28" stroke="#424242" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="10" y1="34" x2="42" y2="34" stroke="#424242" strokeWidth="2" />
      <line x1="25" y1="34" x2="25" y2="40" stroke="#424242" strokeWidth="2" />
      <line x1="8" y1="40" x2="42" y2="40" stroke="#424242" strokeWidth="2.5" />
      <line x1="14" y1="46" x2="36" y2="46" stroke="#424242" strokeWidth="2" />
      <line x1="20" y1="52" x2="30" y2="52" stroke="#424242" strokeWidth="2" />
    </g>
  ),

  // ===== НАГРУЗКА =====
  load: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="8" stroke="#f57c00" strokeWidth="2" />
      <rect x="12" y="8" width="36" height="44" rx="2" fill="#fff8e1" stroke="#f57c00" strokeWidth="2" />
      <line x1="20" y1="22" x2="40" y2="22" stroke="#f57c00" strokeWidth="2" strokeLinecap="round" />
      <line x1="20" y1="30" x2="40" y2="30" stroke="#f57c00" strokeWidth="2" strokeLinecap="round" />
      <line x1="20" y1="38" x2="40" y2="38" stroke="#f57c00" strokeWidth="2" strokeLinecap="round" />
      <line x1="30" y1="52" x2="30" y2="58" stroke="#f57c00" strokeWidth="2" />
    </g>
  ),

  // ===== ШИНЫ И ЗАЗЕМЛЕНИЕ =====
  // Заземление по СТО 56947007-29.240.10.249-2017 (сто_0021)
  ground: ({ className }) => (
    <g className={className}>
      <line x1="25" y1="2" x2="25" y2="10" stroke="#424242" strokeWidth="2" />
      <line x1="8" y1="10" x2="42" y2="10" stroke="#424242" strokeWidth="2.5" />
      <line x1="14" y1="16" x2="36" y2="16" stroke="#424242" strokeWidth="2" />
      <line x1="20" y1="22" x2="30" y2="22" stroke="#424242" strokeWidth="2" />
    </g>
  ),

  // Сборные шины по СТО: линия с точками подключения
  busbar: ({ className }) => (
    <g className={className}>
      <line x1="0" y1="15" x2="120" y2="15" stroke="#546e7a" strokeWidth="3" />
      <line x1="10" y1="3" x2="10" y2="27" stroke="#546e7a" strokeWidth="1.5" />
      <circle cx="10" cy="3" r="2" fill="#546e7a" />
      <line x1="60" y1="3" x2="60" y2="27" stroke="#546e7a" strokeWidth="1.5" />
      <circle cx="60" cy="3" r="2" fill="#546e7a" />
      <line x1="110" y1="3" x2="110" y2="27" stroke="#546e7a" strokeWidth="1.5" />
      <circle cx="110" cy="3" r="2" fill="#546e7a" />
    </g>
  ),

  // ===== КОМПЕНСАЦИЯ | ГОСТ 2.728-74 =====
  capacitor: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="14" stroke="#1565c0" strokeWidth="2" />
      <line x1="10" y1="14" x2="50" y2="14" stroke="#1565c0" strokeWidth="3" strokeLinecap="round" />
      <line x1="10" y1="18" x2="50" y2="18" stroke="#1565c0" strokeWidth="3" strokeLinecap="round" />
      <line x1="30" y1="18" x2="30" y2="44" stroke="#1565c0" strokeWidth="2" />
    </g>
  ),

  // Реактор по ГОСТ 2.728-74: полуокружности (катушка)
  reactor: ({ className }) => (
    <g className={className}>
      <line x1="30" y1="2" x2="30" y2="8" stroke="#6a1b9a" strokeWidth="2" />
      <line x1="30" y1="62" x2="30" y2="68" stroke="#6a1b9a" strokeWidth="2" />
      {[0, 1, 2, 3, 4].map((i) => (
        <path
          key={i}
          d={`M${19 + i * 5} ${8 + i * 11} A5 5.5 0 0 0 ${29 + i * 5} ${8 + i * 11}`}
          fill="none"
          stroke="#6a1b9a"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
    </g>
  ),
};

export interface ComponentLibraryItem {
  id: number;
  code: string;
  name: string;
  category: string;
  description: string;
}

export const COMPONENT_CATEGORIES = {
  source: 'Источники',
  transform: 'Трансформация',
  line: 'Линии',
  switch: 'Коммутация',
  load: 'Нагрузка',
  bus: 'Шины и заземление',
  compensation: 'Компенсация',
};

export interface ComponentParam {
  key: string;
  name: string;
  type: string;
  default: string;
  unit: string;
}