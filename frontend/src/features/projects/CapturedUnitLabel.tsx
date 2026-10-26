/** Presentation of a frozen label only: no conversion or dimension inference. */
export function CapturedUnitLabel({ value }: { value: string | undefined }) {
  return <>{value === undefined ? 'Не сохранена' : value === '' ? 'Пустое обозначение' : value.trim() === '' ? JSON.stringify(value) : value}</>;
}
