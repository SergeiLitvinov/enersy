import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ResultOperatingAssessment } from './ResultOperatingAssessment';
test('missing and undeclared assessments never claim an admissible or stable regime', () => {
  expect(renderToStaticMarkup(<ResultOperatingAssessment />)).toContain('оценка ограничений не сохранена');
  const html = renderToStaticMarkup(<ResultOperatingAssessment assessment={{schema_version:1,policy:'explicit-terminal-voltage-v1',status:'not_declared',checks:[],stability_assessed:false}} />);
  expect(html).toContain('ограничения не заданы');
  expect(html).toContain('устойчивость не оценивалась');
  expect(html).not.toContain('<table');
});
test('violations show equipment terminal, explicit bounds and measured voltage with units', () => {
  const html = renderToStaticMarkup(<ResultOperatingAssessment assessment={{schema_version:1,policy:'explicit-terminal-voltage-v1',status:'violated',stability_assessed:false,
    checks:[{component_id:5,terminal:2,bus_id:3,quantity:'line_to_line_rms_voltage',unit:'kV',min:9.5,max:10.5,measured:9,status:'below_min'}]}} />);
  for (const text of ['Есть нарушения','#5 / 2','Ниже минимума','кВ','9,5','10,5']) expect(html).toContain(text);
});
