import { parseParameterUnitDeclaration, type ParameterUnitDeclaration } from './parameter-unit-declaration';

export interface ComponentCreationInput {
  schemeId: number; typeId: number; x: number; y: number; rotation: number; name: string;
  equipmentModelId?: number | null; projectPassportVersionId?: string | null;
  params?: Readonly<Record<string, string>>;
  parameterUnitDeclaration?: ParameterUnitDeclaration;
}

export function copyCreationParams(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Параметры создания должны быть объектом строк');
  const entries = Object.entries(raw);
  if (entries.length > 256 || entries.some(([key, value]) => !key.trim() || [...key].length > 50 || key.includes('\0') ||
    typeof value !== 'string' || value.includes('\0') || new TextEncoder().encode(value).length > 16384)) throw new Error('Некорректные параметры создания');
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Canonical deep copy for capture, durable identity and retries, never conversion. */
export function copyCreationUnits(raw: unknown, params: Readonly<Record<string, unknown>>): ParameterUnitDeclaration {
  const declaration = parseParameterUnitDeclaration(raw, params);
  if (Object.keys(declaration.units).length > 256) throw new Error('Слишком много единиц создания');
  return { formatVersion: 1, units: Object.fromEntries(Object.entries(declaration.units).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}

export function copyComponentCreation(input: ComponentCreationInput): ComponentCreationInput & { params: Record<string, string> } {
  const params = copyCreationParams(input.params === undefined ? {} : input.params);
  return { ...input, params, ...(input.parameterUnitDeclaration === undefined ? {} : { parameterUnitDeclaration: copyCreationUnits(input.parameterUnitDeclaration, params) }) };
}

export function requireCreationUnits(requested: ParameterUnitDeclaration | undefined, params: Readonly<Record<string, string>>,
  created: { params: Readonly<Record<string, string>>; declaredParameterUnits?: ParameterUnitDeclaration }): void {
  if (requested && Object.entries(requested.units).some(([key, unit]) => created.params[key] !== params[key] || created.declaredParameterUnits?.units[key] !== unit)) {
    throw new Error('Сервер не подтвердил исходные значения и единицы создания. Перечитайте схему и сверьте журнал команды.');
  }
}
