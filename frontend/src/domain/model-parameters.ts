/** Read-only comparison of stored equipment values with a model's input contract.
 * Does not parse physical values, apply defaults, mutate equipment or validate a run.
 */
export interface ModelParameterSpec {
  key: string;
  name: string;
  unit: string;
  kind: 'number' | 'integer' | 'boolean';
  requirement: 'required' | 'optional' | 'conditional';
  default_value: string | null;
  note: string;
}
export function modelParameterRows(specs: readonly ModelParameterSpec[], values: Readonly<Record<string, string>>) {
  return specs.map(spec => {
    const value = Object.prototype.hasOwnProperty.call(values, spec.key) ? values[spec.key] : undefined;
    const presence = value === undefined ? 'missing' : value.trim() === '' ? 'empty' : 'stored';
    return { spec, value, presence };
  });
}
export function unlistedModelParameters(specs: readonly ModelParameterSpec[], values: Readonly<Record<string, string>>) {
  const keys = new Set(specs.map(spec => spec.key));
  return Object.entries(values).filter(([key]) => !keys.has(key));
}
