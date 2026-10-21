import { switchDisplay } from '../../domain/switch-position';

export interface SymbolProps {
  className?: string;
  w?: number;
  h?: number;
  params?: Readonly<Record<string, string>>;
}

/** Adapted contact/function marks from eskd-ugo; grouped conductor marks omitted.
 * Native ports stay (25,0)/(25,60), or only (25,0) for an earthing switch.
 * Unknown status deliberately draws neither a closed nor an open blade.
 */
export function SwitchSymbol({ kind, className, params }: SymbolProps & {
  kind: 'breaker' | 'disconnector' | 'grounding_switch';
}) {
  const display = switchDisplay(kind, params);
  const earth = kind === 'grounding_switch';
  const pivotY = earth ? 36 : 42;
  return <g className={className} data-switch-position={display.position}
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <title>{display.description}{earth ? ' · Расчёт этого типа не поддержан' : ''}</title>
    <path d={`M25 0 V18 M25 ${pivotY} V${earth ? 46 : 60}`} />
    {kind === 'breaker'
      ? <path d="M21 14 L29 22 M29 14 L21 22" />
      : <path d="M20 18 H30" />}
    {display.position === 'unknown'
      ? <text x="25" y="32" textAnchor="middle" style={{ stroke: 'none' }} fill="currentColor" fontSize="16">?</text>
      : <path data-contact="blade" d={`M25 ${pivotY} L${display.position === 'closed' ? 25 : 11} 18`} />}
    {earth && <path d="M9 46 H41 M15 52 H35 M21 58 H29" />}
  </g>;
}
