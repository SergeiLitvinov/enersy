import { SwitchSymbol, type SymbolProps } from './SwitchSymbol';

// The single-terminal legacy AC shunts return to a mathematical reference.
// Never draw a protective earth or an accessible neutral that the model lacks.
function ShuntReference({ y }: { y: number }) {
  return <g>
    <path d={`M30 ${y} v7`} strokeDasharray="2 3" />
    <text x="30" y={y + 17} textAnchor="middle" fontSize="9" fill="currentColor" style={{ stroke: 'none' }}>ref</text>
  </g>;
}

export const ComponentSVG: Record<string, React.FC<SymbolProps>> = {

  // ===== ИСТОЧНИКИ: однолинейное представление =====
  // Generic AC source; machine subtype is not inferred.
  generator: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M30 0 V10 M30 50 V60" />
      <circle cx="30" cy="30" r="20" />
      <path d="M18 30 C22 18 26 18 30 30 S38 42 42 30" />
    </g>
  ),

  // ===== ТРАНСФОРМАЦИЯ =====
  // Circle geometry adapted from eskd-ugo 0.1.1.dev7, two-winding
  // unmarked draft; leads extended to existing ports. Provenance and limits:
  // docs/site/development/diagram-views.md, "Источники геометрии".
  transformer: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M30 0 V15.6 M30 64.4 V80" />
      <circle cx="30" cy="31.6" r="16" />
      <circle cx="30" cy="48.4" r="16" />
    </g>
  ),

  // Three distinct winding groups, matched to the saved top / bl / br ports.
  // No star/delta, neutral or clock number is inferred from the equipment type.
  transformer_3w: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M30 0 V14 M17 67 V76 H8 V90 M43 67 V76 H52 V90" />
      <circle cx="30" cy="30" r="16" />
      <circle cx="17" cy="51" r="16" />
      <circle cx="43" cy="51" r="16" />
    </g>
  ),

  // Adapted from the local eskd-ugo review; see diagram-views.md for scope.
  autotransformer: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <title>Автотрансформатор · общий знак, без назначения группы соединения или нейтрали · расчёт не поддержан</title>
      <path d="M30 0 V10.75 M30 69.25 V80" />
      <circle cx="30" cy="31.875" r="14.625" />
      <circle cx="30" cy="54.625" r="14.625" />
      <path d="M44.625 31.875 A20.925074 20.925074 0 0 0 30 10.75" />
    </g>
  ),

  // ===== ЛИНИИ =====
  // Single-line view: both saved ports lie on the conductor centreline.
  transmission_line: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M0 20 H100" />
    </g>
  ),

  // ===== КОММУТАЦИЯ: положение из сохранённого status =====
  // Adapted from the local eskd-ugo review; see diagram-views.md for scope.
  breaker: (props) => <SwitchSymbol {...props} kind="breaker" />,

  // Disconnector with an explicit fixed-contact mark.
  disconnector: (props) => <SwitchSymbol {...props} kind="disconnector" />,

  // Earthing switch; display support does not enable its calculation.
  grounding_switch: (props) => <SwitchSymbol {...props} kind="grounding_switch" />,

  // ===== НАГРУЗКА =====
  // One external connection: a consumption arrow, not a two-terminal resistor.
  load: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M30 0 V50 M18 34 L30 50 L42 34" />
    </g>
  ),

  // ===== ШИНЫ И ЗАЗЕМЛЕНИЕ =====
  // Adapted earth_general from eskd-ugo; unchanged saved top port.
  ground: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <title>Знак земли · отдельная расчётная модель заземления пока не поддержана</title>
      <path d="M25 0 V24.5 M11 24.5 H39 M16.25 29.75 H33.75 M21.5 35 H28.5" />
    </g>
  ),

  // No decorative branch creates a fictitious selectable terminal.
  busbar: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
      <title>Общая шина · left и right — точки подключения одного электрического терминала</title>
      <path d="M0 15 H120" />
    </g>
  ),

  // ===== КОМПЕНСАЦИЯ: одноточечные AC-шунты =====
  capacitor: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <title>Ёмкостный AC-шунт · ref — опорный потенциал модели, не физическая нейтраль или земля</title>
      <path d="M30 0 V20 M15 20 H45 M15 28 H45 M30 28 V40" />
      <ShuntReference y={40} />
    </g>
  ),

  // Equipment sign redrawn from the user's reactor reference (2026-10-18).
  // The winding/inductance symbol belongs to the equivalent circuit, not here.
  reactor: ({ className }) => (
    <g className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <title>Реактор · УГО оборудования по образцу пользователя; ref — опорный потенциал текущей AC-модели, не нейтраль или земля</title>
      <path transform="translate(30 35) rotate(90)" d="M-35 0 H-14 A14 14 0 1 1 0 14 V0 H15" />
      <ShuntReference y={50} />
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
