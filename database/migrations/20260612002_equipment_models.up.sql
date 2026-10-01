-- Equipment models catalog: predefined presets for each component type

CREATE TABLE IF NOT EXISTS equipment_models (
    id SERIAL PRIMARY KEY,
    component_type_id INTEGER REFERENCES component_types(id),
    model_name VARCHAR(100) NOT NULL,
    manufacturer VARCHAR(100),
    description TEXT,
    UNIQUE(component_type_id, model_name)
);

CREATE TABLE IF NOT EXISTS equipment_model_params (
    id SERIAL PRIMARY KEY,
    equipment_model_id INTEGER REFERENCES equipment_models(id) ON DELETE CASCADE,
    param_key VARCHAR(50) NOT NULL,
    param_value TEXT NOT NULL,
    UNIQUE(equipment_model_id, param_key)
);

-- ============================================================
-- GENERATORS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВФ-63-2У3', 'Элсиб', 'Турбогенератор 63 МВт, 10.5 кВ, cosφ=0.8'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВФ-120-2У3', 'Элсиб', 'Турбогенератор 120 МВт, 10.5 кВ, cosφ=0.8'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВВ-200-2АУ3', 'Электросила', 'Турбогенератор 200 МВт, 15.75 кВ, cosφ=0.85'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВВ-320-2У3', 'Электросила', 'Турбогенератор 320 МВт, 20 кВ, cosφ=0.85'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВВ-500-2У3', 'Электросила', 'Турбогенератор 500 МВт, 20 кВ, cosφ=0.85'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВВ-800-2У3', 'Электросила', 'Турбогенератор 800 МВт, 24 кВ, cosφ=0.9'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'ТВВ-1000-4У3', 'Электросила', 'Турбогенератор 1000 МВт, 24 кВ, cosφ=0.9'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'СВ-850/190-24', 'Уралэлектротяжмаш', 'Гидрогенератор 71 МВт, 10.5 кВ'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'СВ-1500/200-88', 'Уралэлектротяжмаш', 'Гидрогенератор 150 МВт, 15.75 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('ТВФ-63-2У3', 'voltage_nom', '10.5'), ('ТВФ-63-2У3', 'power_nom', '78.75'), ('ТВФ-63-2У3', 'x', '0.153'), ('ТВФ-63-2У3', 'e', '11.0'), ('ТВФ-63-2У3', 'p', '63.0'),
    ('ТВФ-120-2У3', 'voltage_nom', '10.5'), ('ТВФ-120-2У3', 'power_nom', '150.0'), ('ТВФ-120-2У3', 'x', '0.192'), ('ТВФ-120-2У3', 'e', '11.0'), ('ТВФ-120-2У3', 'p', '120.0'),
    ('ТВВ-200-2АУ3', 'voltage_nom', '15.75'), ('ТВВ-200-2АУ3', 'power_nom', '235.0'), ('ТВВ-200-2АУ3', 'x', '0.185'), ('ТВВ-200-2АУ3', 'e', '16.5'), ('ТВВ-200-2АУ3', 'p', '200.0'),
    ('ТВВ-320-2У3', 'voltage_nom', '20.0'), ('ТВВ-320-2У3', 'power_nom', '376.0'), ('ТВВ-320-2У3', 'x', '0.180'), ('ТВВ-320-2У3', 'e', '21.0'), ('ТВВ-320-2У3', 'p', '320.0'),
    ('ТВВ-500-2У3', 'voltage_nom', '20.0'), ('ТВВ-500-2У3', 'power_nom', '588.0'), ('ТВВ-500-2У3', 'x', '0.175'), ('ТВВ-500-2У3', 'e', '21.0'), ('ТВВ-500-2У3', 'p', '500.0'),
    ('ТВВ-800-2У3', 'voltage_nom', '24.0'), ('ТВВ-800-2У3', 'power_nom', '889.0'), ('ТВВ-800-2У3', 'x', '0.170'), ('ТВВ-800-2У3', 'e', '25.2'), ('ТВВ-800-2У3', 'p', '800.0'),
    ('ТВВ-1000-4У3', 'voltage_nom', '24.0'), ('ТВВ-1000-4У3', 'power_nom', '1111.0'), ('ТВВ-1000-4У3', 'x', '0.165'), ('ТВВ-1000-4У3', 'e', '25.2'), ('ТВВ-1000-4У3', 'p', '1000.0'),
    ('СВ-850/190-24', 'voltage_nom', '10.5'), ('СВ-850/190-24', 'power_nom', '84.0'), ('СВ-850/190-24', 'x', '0.210'), ('СВ-850/190-24', 'e', '11.0'), ('СВ-850/190-24', 'p', '71.0'),
    ('СВ-1500/200-88', 'voltage_nom', '15.75'), ('СВ-1500/200-88', 'power_nom', '176.0'), ('СВ-1500/200-88', 'x', '0.200'), ('СВ-1500/200-88', 'e', '16.5'), ('СВ-1500/200-88', 'p', '150.0')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- TWO-WINDING TRANSFORMERS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТМ-1000/10', 'МЭТЗ', 'Трансформатор 1 МВА, 10/0.4 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТМ-2500/10', 'МЭТЗ', 'Трансформатор 2.5 МВА, 10/0.4 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТД-16000/35', 'Укртрансформатор', 'Трансформатор 16 МВА, 35/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТДН-16000/110', 'АТМ', 'Трансформатор 16 МВА, 115/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТДН-25000/110', 'АТМ', 'Трансформатор 25 МВА, 115/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТДН-40000/110', 'АТМ', 'Трансформатор 40 МВА, 115/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТРДН-40000/110', 'АТМ', 'Трансформатор 40 МВА, 115/10.5-10.5 кВ (расщеплённая обмотка)'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТДН-63000/110', 'АТМ', 'Трансформатор 63 МВА, 115/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТДЦ-125000/110', 'АТМ', 'Трансформатор 125 МВА, 115/10.5 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТДЦ-200000/110', 'АТМ', 'Трансформатор 200 МВА, 115/15.75 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'ТЦ-630000/500', 'АТМ', 'Трансформатор 630 МВА, 525/20 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('ТМ-1000/10', 'power_nom', '1.0'), ('ТМ-1000/10', 'voltage_hv', '10.0'), ('ТМ-1000/10', 'voltage_lv', '0.4'), ('ТМ-1000/10', 'p_kz', '0.012'), ('ТМ-1000/10', 'u_kz', '5.5'), ('ТМ-1000/10', 'p_xx', '0.002'), ('ТМ-1000/10', 'i_xx', '1.4'),
    ('ТМ-2500/10', 'power_nom', '2.5'), ('ТМ-2500/10', 'voltage_hv', '10.0'), ('ТМ-2500/10', 'voltage_lv', '0.4'), ('ТМ-2500/10', 'p_kz', '0.025'), ('ТМ-2500/10', 'u_kz', '5.5'), ('ТМ-2500/10', 'p_xx', '0.004'), ('ТМ-2500/10', 'i_xx', '1.0'),
    ('ТД-16000/35', 'power_nom', '16.0'), ('ТД-16000/35', 'voltage_hv', '35.0'), ('ТД-16000/35', 'voltage_lv', '11.0'), ('ТД-16000/35', 'p_kz', '0.090'), ('ТД-16000/35', 'u_kz', '8.0'), ('ТД-16000/35', 'p_xx', '0.021'), ('ТД-16000/35', 'i_xx', '0.8'),
    ('ТДН-16000/110', 'power_nom', '16.0'), ('ТДН-16000/110', 'voltage_hv', '115.0'), ('ТДН-16000/110', 'voltage_lv', '11.0'), ('ТДН-16000/110', 'p_kz', '0.085'), ('ТДН-16000/110', 'u_kz', '10.5'), ('ТДН-16000/110', 'p_xx', '0.018'), ('ТДН-16000/110', 'i_xx', '0.7'),
    ('ТДН-25000/110', 'power_nom', '25.0'), ('ТДН-25000/110', 'voltage_hv', '115.0'), ('ТДН-25000/110', 'voltage_lv', '11.0'), ('ТДН-25000/110', 'p_kz', '0.120'), ('ТДН-25000/110', 'u_kz', '10.5'), ('ТДН-25000/110', 'p_xx', '0.025'), ('ТДН-25000/110', 'i_xx', '0.65'),
    ('ТДН-40000/110', 'power_nom', '40.0'), ('ТДН-40000/110', 'voltage_hv', '115.0'), ('ТДН-40000/110', 'voltage_lv', '11.0'), ('ТДН-40000/110', 'p_kz', '0.170'), ('ТДН-40000/110', 'u_kz', '10.5'), ('ТДН-40000/110', 'p_xx', '0.034'), ('ТДН-40000/110', 'i_xx', '0.55'),
    ('ТРДН-40000/110', 'power_nom', '40.0'), ('ТРДН-40000/110', 'voltage_hv', '115.0'), ('ТРДН-40000/110', 'voltage_lv', '10.5'), ('ТРДН-40000/110', 'p_kz', '0.170'), ('ТРДН-40000/110', 'u_kz', '10.5'), ('ТРДН-40000/110', 'p_xx', '0.034'), ('ТРДН-40000/110', 'i_xx', '0.55'),
    ('ТДН-63000/110', 'power_nom', '63.0'), ('ТДН-63000/110', 'voltage_hv', '115.0'), ('ТДН-63000/110', 'voltage_lv', '11.0'), ('ТДН-63000/110', 'p_kz', '0.260'), ('ТДН-63000/110', 'u_kz', '10.5'), ('ТДН-63000/110', 'p_xx', '0.050'), ('ТДН-63000/110', 'i_xx', '0.5'),
    ('ТДЦ-125000/110', 'power_nom', '125.0'), ('ТДЦ-125000/110', 'voltage_hv', '115.0'), ('ТДЦ-125000/110', 'voltage_lv', '10.5'), ('ТДЦ-125000/110', 'p_kz', '0.400'), ('ТДЦ-125000/110', 'u_kz', '10.5'), ('ТДЦ-125000/110', 'p_xx', '0.080'), ('ТДЦ-125000/110', 'i_xx', '0.4'),
    ('ТДЦ-200000/110', 'power_nom', '200.0'), ('ТДЦ-200000/110', 'voltage_hv', '115.0'), ('ТДЦ-200000/110', 'voltage_lv', '15.75'), ('ТДЦ-200000/110', 'p_kz', '0.550'), ('ТДЦ-200000/110', 'u_kz', '11.0'), ('ТДЦ-200000/110', 'p_xx', '0.120'), ('ТДЦ-200000/110', 'i_xx', '0.35'),
    ('ТЦ-630000/500', 'power_nom', '630.0'), ('ТЦ-630000/500', 'voltage_hv', '525.0'), ('ТЦ-630000/500', 'voltage_lv', '20.0'), ('ТЦ-630000/500', 'p_kz', '1.200'), ('ТЦ-630000/500', 'u_kz', '14.0'), ('ТЦ-630000/500', 'p_xx', '0.250'), ('ТЦ-630000/500', 'i_xx', '0.3')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- THREE-WINDING TRANSFORMERS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'ТДТН-25000/110', 'АТМ', 'Трёхобмоточный 25 МВА, 115/38.5/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'ТДТН-40000/110', 'АТМ', 'Трёхобмоточный 40 МВА, 115/38.5/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'ТДТН-63000/110', 'АТМ', 'Трёхобмоточный 63 МВА, 115/38.5/11 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('ТДТН-25000/110', 'power_nom', '25.0'), ('ТДТН-25000/110', 'voltage_hv', '115.0'), ('ТДТН-25000/110', 'voltage_mv', '38.5'), ('ТДТН-25000/110', 'voltage_lv', '11.0'),
    ('ТДТН-25000/110', 'p_kz_hv_mv', '0.120'), ('ТДТН-25000/110', 'p_kz_hv_lv', '0.115'), ('ТДТН-25000/110', 'p_kz_mv_lv', '0.110'),
    ('ТДТН-25000/110', 'u_kz_hv_mv', '10.5'), ('ТДТН-25000/110', 'u_kz_hv_lv', '17.0'), ('ТДТН-25000/110', 'u_kz_mv_lv', '6.5'),
    ('ТДТН-25000/110', 'p_xx', '0.025'), ('ТДТН-25000/110', 'i_xx', '0.7'),
    ('ТДТН-40000/110', 'power_nom', '40.0'), ('ТДТН-40000/110', 'voltage_hv', '115.0'), ('ТДТН-40000/110', 'voltage_mv', '38.5'), ('ТДТН-40000/110', 'voltage_lv', '11.0'),
    ('ТДТН-40000/110', 'p_kz_hv_mv', '0.170'), ('ТДТН-40000/110', 'p_kz_hv_lv', '0.165'), ('ТДТН-40000/110', 'p_kz_mv_lv', '0.160'),
    ('ТДТН-40000/110', 'u_kz_hv_mv', '10.5'), ('ТДТН-40000/110', 'u_kz_hv_lv', '17.5'), ('ТДТН-40000/110', 'u_kz_mv_lv', '6.5'),
    ('ТДТН-40000/110', 'p_xx', '0.034'), ('ТДТН-40000/110', 'i_xx', '0.55'),
    ('ТДТН-63000/110', 'power_nom', '63.0'), ('ТДТН-63000/110', 'voltage_hv', '115.0'), ('ТДТН-63000/110', 'voltage_mv', '38.5'), ('ТДТН-63000/110', 'voltage_lv', '11.0'),
    ('ТДТН-63000/110', 'p_kz_hv_mv', '0.260'), ('ТДТН-63000/110', 'p_kz_hv_lv', '0.250'), ('ТДТН-63000/110', 'p_kz_mv_lv', '0.240'),
    ('ТДТН-63000/110', 'u_kz_hv_mv', '10.5'), ('ТДТН-63000/110', 'u_kz_hv_lv', '17.5'), ('ТДТН-63000/110', 'u_kz_mv_lv', '6.5'),
    ('ТДТН-63000/110', 'p_xx', '0.050'), ('ТДТН-63000/110', 'i_xx', '0.5')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- AUTOTRANSFORMERS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-125000/220/110', 'АТМ', 'Автотрансформатор 125 МВА, 230/121 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-200000/220/110', 'АТМ', 'Автотрансформатор 200 МВА, 230/121 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-250000/330/110', 'АТМ', 'Автотрансформатор 250 МВА, 330/121 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-500000/500/220', 'АТМ', 'Автотрансформатор 500 МВА, 525/242 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АОДЦТН-167000/500/220', 'АТМ', 'Автотрансформатор 167 МВА (одна фаза), 500/220 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('АТДЦТН-125000/220/110', 'power_nom', '125.0'), ('АТДЦТН-125000/220/110', 'voltage_hv', '230.0'), ('АТДЦТН-125000/220/110', 'voltage_mv', '121.0'), ('АТДЦТН-125000/220/110', 'voltage_lv', '11.0'),
    ('АТДЦТН-125000/220/110', 'p_kz', '0.300'), ('АТДЦТН-125000/220/110', 'u_kz', '11.0'), ('АТДЦТН-125000/220/110', 'p_xx', '0.050'), ('АТДЦТН-125000/220/110', 'i_xx', '0.3'),
    ('АТДЦТН-200000/220/110', 'power_nom', '200.0'), ('АТДЦТН-200000/220/110', 'voltage_hv', '230.0'), ('АТДЦТН-200000/220/110', 'voltage_mv', '121.0'), ('АТДЦТН-200000/220/110', 'voltage_lv', '11.0'),
    ('АТДЦТН-200000/220/110', 'p_kz', '0.420'), ('АТДЦТН-200000/220/110', 'u_kz', '11.5'), ('АТДЦТН-200000/220/110', 'p_xx', '0.080'), ('АТДЦТН-200000/220/110', 'i_xx', '0.25'),
    ('АТДЦТН-250000/330/110', 'power_nom', '250.0'), ('АТДЦТН-250000/330/110', 'voltage_hv', '330.0'), ('АТДЦТН-250000/330/110', 'voltage_mv', '121.0'), ('АТДЦТН-250000/330/110', 'voltage_lv', '11.0'),
    ('АТДЦТН-250000/330/110', 'p_kz', '0.500'), ('АТДЦТН-250000/330/110', 'u_kz', '11.5'), ('АТДЦТН-250000/330/110', 'p_xx', '0.100'), ('АТДЦТН-250000/330/110', 'i_xx', '0.2'),
    ('АТДЦТН-500000/500/220', 'power_nom', '500.0'), ('АТДЦТН-500000/500/220', 'voltage_hv', '525.0'), ('АТДЦТН-500000/500/220', 'voltage_mv', '242.0'), ('АТДЦТН-500000/500/220', 'voltage_lv', '15.75'),
    ('АТДЦТН-500000/500/220', 'p_kz', '0.700'), ('АТДЦТН-500000/500/220', 'u_kz', '12.0'), ('АТДЦТН-500000/500/220', 'p_xx', '0.150'), ('АТДЦТН-500000/500/220', 'i_xx', '0.15'),
    ('АОДЦТН-167000/500/220', 'power_nom', '167.0'), ('АОДЦТН-167000/500/220', 'voltage_hv', '525.0'), ('АОДЦТН-167000/500/220', 'voltage_mv', '242.0'), ('АОДЦТН-167000/500/220', 'voltage_lv', '15.75'),
    ('АОДЦТН-167000/500/220', 'p_kz', '0.250'), ('АОДЦТН-167000/500/220', 'u_kz', '12.0'), ('АОДЦТН-167000/500/220', 'p_xx', '0.060'), ('АОДЦТН-167000/500/220', 'i_xx', '0.15')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- TRANSMISSION LINES (conductors)
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-70/11', 'Энергокабель', 'Провод 70 мм², 0.428 Ом/км, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-95/16', 'Энергокабель', 'Провод 95 мм², 0.306 Ом/км, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-120/19', 'Энергокабель', 'Провод 120 мм², 0.249 Ом/км, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-150/24', 'Энергокабель', 'Провод 150 мм², 0.198 Ом/км, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-185/29', 'Энергокабель', 'Провод 185 мм², 0.162 Ом/км, 110-220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-240/32', 'Энергокабель', 'Провод 240 мм², 0.120 Ом/км, 110-220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-300/39', 'Энергокабель', 'Провод 300 мм², 0.096 Ом/км, 220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-400/51', 'Энергокабель', 'Провод 400 мм², 0.075 Ом/км, 220-330 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'АС-500/64', 'Энергокабель', 'Провод 500 мм², 0.060 Ом/км, 330-500 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), '2хАС-300/39', 'Энергокабель', '2 провода 300 мм² в фазе, 0.048 Ом/км, 330 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), '2хАС-400/51', 'Энергокабель', '2 провода 400 мм² в фазе, 0.037 Ом/км, 330-500 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), '3хАС-400/51', 'Энергокабель', '3 провода 400 мм² в фазе, 0.025 Ом/км, 500 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), '3хАС-500/64', 'Энергокабель', '3 провода 500 мм² в фазе, 0.020 Ом/км, 500-750 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'Кабель СБ-3х240', 'Энергокабель', 'Силовой кабель 3х240 мм², 10 кВ, 0.129 Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'Кабель ААБ-3х150', 'Энергокабель', 'Силовой кабель 3х150 мм², 10 кВ, 0.206 Ом/км')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('АС-70/11', 'r0', '0.428'), ('АС-70/11', 'x0', '0.444'), ('АС-70/11', 'b0', '0.00000255'), ('АС-70/11', 'circuits', '1'),
    ('АС-95/16', 'r0', '0.306'), ('АС-95/16', 'x0', '0.434'), ('АС-95/16', 'b0', '0.00000261'), ('АС-95/16', 'circuits', '1'),
    ('АС-120/19', 'r0', '0.249'), ('АС-120/19', 'x0', '0.427'), ('АС-120/19', 'b0', '0.00000266'), ('АС-120/19', 'circuits', '1'),
    ('АС-150/24', 'r0', '0.198'), ('АС-150/24', 'x0', '0.420'), ('АС-150/24', 'b0', '0.00000270'), ('АС-150/24', 'circuits', '1'),
    ('АС-185/29', 'r0', '0.162'), ('АС-185/29', 'x0', '0.413'), ('АС-185/29', 'b0', '0.00000275'), ('АС-185/29', 'circuits', '1'),
    ('АС-240/32', 'r0', '0.120'), ('АС-240/32', 'x0', '0.405'), ('АС-240/32', 'b0', '0.00000281'), ('АС-240/32', 'circuits', '1'),
    ('АС-300/39', 'r0', '0.096'), ('АС-300/39', 'x0', '0.398'), ('АС-300/39', 'b0', '0.00000286'), ('АС-300/39', 'circuits', '1'),
    ('АС-400/51', 'r0', '0.075'), ('АС-400/51', 'x0', '0.391'), ('АС-400/51', 'b0', '0.00000291'), ('АС-400/51', 'circuits', '1'),
    ('АС-500/64', 'r0', '0.060'), ('АС-500/64', 'x0', '0.385'), ('АС-500/64', 'b0', '0.00000296'), ('АС-500/64', 'circuits', '1'),
    ('2хАС-300/39', 'r0', '0.048'), ('2хАС-300/39', 'x0', '0.321'), ('2хАС-300/39', 'b0', '0.00000330'), ('2хАС-300/39', 'circuits', '1'),
    ('2хАС-400/51', 'r0', '0.037'), ('2хАС-400/51', 'x0', '0.315'), ('2хАС-400/51', 'b0', '0.00000340'), ('2хАС-400/51', 'circuits', '1'),
    ('3хАС-400/51', 'r0', '0.025'), ('3хАС-400/51', 'x0', '0.302'), ('3хАС-400/51', 'b0', '0.00000355'), ('3хАС-400/51', 'circuits', '1'),
    ('3хАС-500/64', 'r0', '0.020'), ('3хАС-500/64', 'x0', '0.298'), ('3хАС-500/64', 'b0', '0.00000365'), ('3хАС-500/64', 'circuits', '1'),
    ('Кабель СБ-3х240', 'r0', '0.129'), ('Кабель СБ-3х240', 'x0', '0.071'), ('Кабель СБ-3х240', 'b0', '0.00000110'), ('Кабель СБ-3х240', 'circuits', '1'),
    ('Кабель ААБ-3х150', 'r0', '0.206'), ('Кабель ААБ-3х150', 'x0', '0.074'), ('Кабель ААБ-3х150', 'b0', '0.00000105'), ('Кабель ААБ-3х150', 'circuits', '1')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- LOADS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'load'), 'Промышленная нагрузка', '—', 'Типовая промышленная нагрузка, P=50 МВт, Q=25 Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'Коммунально-бытовая нагрузка', '—', 'Типовая городская нагрузка, P=10 МВт, Q=4 Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'Смешанная нагрузка', '—', 'Промышленно-бытовая смешанная, P=30 МВт, Q=15 Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'Тяговая нагрузка', '—', 'Тяговая подстанция ж/д, P=20 МВт, Q=10 Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'Сельскохозяйственная нагрузка', '—', 'Сельская нагрузка, P=5 МВт, Q=2 Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'Нефтедобыча (ЭЦН)', '—', 'Нагрузка нефтедобычи, P=15 МВт, Q=7.5 Мвар')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('Промышленная нагрузка', 'p', '50.0'), ('Промышленная нагрузка', 'q', '25.0'), ('Промышленная нагрузка', 'voltage_nom', '110.0'),
    ('Коммунально-бытовая нагрузка', 'p', '10.0'), ('Коммунально-бытовая нагрузка', 'q', '4.0'), ('Коммунально-бытовая нагрузка', 'voltage_nom', '10.0'),
    ('Смешанная нагрузка', 'p', '30.0'), ('Смешанная нагрузка', 'q', '15.0'), ('Смешанная нагрузка', 'voltage_nom', '110.0'),
    ('Тяговая нагрузка', 'p', '20.0'), ('Тяговая нагрузка', 'q', '10.0'), ('Тяговая нагрузка', 'voltage_nom', '110.0'),
    ('Сельскохозяйственная нагрузка', 'p', '5.0'), ('Сельскохозяйственная нагрузка', 'q', '2.0'), ('Сельскохозяйственная нагрузка', 'voltage_nom', '10.0'),
    ('Нефтедобыча (ЭЦН)', 'p', '15.0'), ('Нефтедобыча (ЭЦН)', 'q', '7.5'), ('Нефтедобыча (ЭЦН)', 'voltage_nom', '35.0')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- CAPACITOR BANKS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'БСК-10-6.3', 'Электрокерамика', 'Батарея 6.3 Мвар, 10.5 кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'БСК-10-12.5', 'Электрокерамика', 'Батарея 12.5 Мвар, 10.5 кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'БСК-35-25', 'Электрокерамика', 'Батарея 25 Мвар, 35 кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'БСК-110-50', 'Электрокерамика', 'Батарея 50 Мвар, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'БСК-220-100', 'Электрокерамика', 'Батарея 100 Мвар, 220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'УКРМ-0.4-400', 'Электрокерамика', 'Установка компенсации 400 квар, 0.4 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('БСК-10-6.3', 'voltage_nom', '10.5'), ('БСК-10-6.3', 'q_nom', '6.3'), ('БСК-10-6.3', 'c', '182.0'),
    ('БСК-10-12.5', 'voltage_nom', '10.5'), ('БСК-10-12.5', 'q_nom', '12.5'), ('БСК-10-12.5', 'c', '361.0'),
    ('БСК-35-25', 'voltage_nom', '35.0'), ('БСК-35-25', 'q_nom', '25.0'), ('БСК-35-25', 'c', '6.5'),
    ('БСК-110-50', 'voltage_nom', '110.0'), ('БСК-110-50', 'q_nom', '50.0'), ('БСК-110-50', 'c', '1.32'),
    ('БСК-220-100', 'voltage_nom', '220.0'), ('БСК-220-100', 'q_nom', '100.0'), ('БСК-220-100', 'c', '0.66'),
    ('УКРМ-0.4-400', 'voltage_nom', '0.4'), ('УКРМ-0.4-400', 'q_nom', '0.4'), ('УКРМ-0.4-400', 'c', '7960.0')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- SHUNT REACTORS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-110-25', 'Электрокерамика', 'Шунтирующий реактор 25 Мвар, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-110-50', 'Электрокерамика', 'Шунтирующий реактор 50 Мвар, 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-220-50', 'Электрокерамика', 'Шунтирующий реактор 50 Мвар, 220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-220-100', 'Электрокерамика', 'Шунтирующий реактор 100 Мвар, 220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-330-100', 'Электрокерамика', 'Шунтирующий реактор 100 Мвар, 330 кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-500-150', 'Электрокерамика', 'Шунтирующий реактор 150 Мвар, 500 кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'РДС-750-200', 'Электрокерамика', 'Шунтирующий реактор 200 Мвар, 750 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('РДС-110-25', 'voltage_nom', '110.0'), ('РДС-110-25', 'q_nom', '25.0'), ('РДС-110-25', 'l', '0.462'),
    ('РДС-110-50', 'voltage_nom', '110.0'), ('РДС-110-50', 'q_nom', '50.0'), ('РДС-110-50', 'l', '0.231'),
    ('РДС-220-50', 'voltage_nom', '220.0'), ('РДС-220-50', 'q_nom', '50.0'), ('РДС-220-50', 'l', '0.924'),
    ('РДС-220-100', 'voltage_nom', '220.0'), ('РДС-220-100', 'q_nom', '100.0'), ('РДС-220-100', 'l', '0.462'),
    ('РДС-330-100', 'voltage_nom', '330.0'), ('РДС-330-100', 'q_nom', '100.0'), ('РДС-330-100', 'l', '1.04'),
    ('РДС-500-150', 'voltage_nom', '500.0'), ('РДС-500-150', 'q_nom', '150.0'), ('РДС-500-150', 'l', '1.68'),
    ('РДС-750-200', 'voltage_nom', '750.0'), ('РДС-750-200', 'q_nom', '200.0'), ('РДС-750-200', 'l', '2.81')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- CIRCUIT BREAKERS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВМТ-110Б-25/1250', 'Электроаппарат', 'Масляный выключатель 110 кВ, 1250 А, 25 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВГБ-110-40/2500', 'Электроаппарат', 'Элегазовый выключатель 110 кВ, 2500 А, 40 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВГБ-220-40/2500', 'Электроаппарат', 'Элегазовый выключатель 220 кВ, 2500 А, 40 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВВБ-220-31.5/2000', 'Электроаппарат', 'Воздушный выключатель 220 кВ, 2000 А, 31.5 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВЭБ-330-40/2500', 'Электроаппарат', 'Элегазовый выключатель 330 кВ, 2500 А, 40 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВЭБ-500-40/3150', 'Электроаппарат', 'Элегазовый выключатель 500 кВ, 3150 А, 40 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВЭБ-750-40/3150', 'Электроаппарат', 'Элегазовый выключатель 750 кВ, 3150 А, 40 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВВЭ-10-20/1000', 'Электроаппарат', 'Вакуумный выключатель 10 кВ, 1000 А, 20 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВВЭ-10-31.5/1600', 'Электроаппарат', 'Вакуумный выключатель 10 кВ, 1600 А, 31.5 кА'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'ВВЭ-35-25/1250', 'Электроаппарат', 'Вакуумный выключатель 35 кВ, 1250 А, 25 кА')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('ВМТ-110Б-25/1250', 'voltage_nom', '110.0'), ('ВМТ-110Б-25/1250', 'current_nom', '1250.0'), ('ВМТ-110Б-25/1250', 'status', 'true'),
    ('ВГБ-110-40/2500', 'voltage_nom', '110.0'), ('ВГБ-110-40/2500', 'current_nom', '2500.0'), ('ВГБ-110-40/2500', 'status', 'true'),
    ('ВГБ-220-40/2500', 'voltage_nom', '220.0'), ('ВГБ-220-40/2500', 'current_nom', '2500.0'), ('ВГБ-220-40/2500', 'status', 'true'),
    ('ВВБ-220-31.5/2000', 'voltage_nom', '220.0'), ('ВВБ-220-31.5/2000', 'current_nom', '2000.0'), ('ВВБ-220-31.5/2000', 'status', 'true'),
    ('ВЭБ-330-40/2500', 'voltage_nom', '330.0'), ('ВЭБ-330-40/2500', 'current_nom', '2500.0'), ('ВЭБ-330-40/2500', 'status', 'true'),
    ('ВЭБ-500-40/3150', 'voltage_nom', '500.0'), ('ВЭБ-500-40/3150', 'current_nom', '3150.0'), ('ВЭБ-500-40/3150', 'status', 'true'),
    ('ВЭБ-750-40/3150', 'voltage_nom', '750.0'), ('ВЭБ-750-40/3150', 'current_nom', '3150.0'), ('ВЭБ-750-40/3150', 'status', 'true'),
    ('ВВЭ-10-20/1000', 'voltage_nom', '10.0'), ('ВВЭ-10-20/1000', 'current_nom', '1000.0'), ('ВВЭ-10-20/1000', 'status', 'true'),
    ('ВВЭ-10-31.5/1600', 'voltage_nom', '10.0'), ('ВВЭ-10-31.5/1600', 'current_nom', '1600.0'), ('ВВЭ-10-31.5/1600', 'status', 'true'),
    ('ВВЭ-35-25/1250', 'voltage_nom', '35.0'), ('ВВЭ-35-25/1250', 'current_nom', '1250.0'), ('ВВЭ-35-25/1250', 'status', 'true')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- DISCONNECTORS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-110/1000', 'Электроаппарат', 'Разъединитель 110 кВ, 1000 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-110/2000', 'Электроаппарат', 'Разъединитель 110 кВ, 2000 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-220/1000', 'Электроаппарат', 'Разъединитель 220 кВ, 1000 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-220/2000', 'Электроаппарат', 'Разъединитель 220 кВ, 2000 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-330/2000', 'Электроаппарат', 'Разъединитель 330 кВ, 2000 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-500/3150', 'Электроаппарат', 'Разъединитель 500 кВ, 3150 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РНДЗ-750/3150', 'Электроаппарат', 'Разъединитель 750 кВ, 3150 А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'РВ-10/1000', 'Электроаппарат', 'Разъединитель 10 кВ, 1000 А')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('РНДЗ-110/1000', 'voltage_nom', '110.0'), ('РНДЗ-110/1000', 'current_nom', '1000.0'), ('РНДЗ-110/1000', 'status', 'true'),
    ('РНДЗ-110/2000', 'voltage_nom', '110.0'), ('РНДЗ-110/2000', 'current_nom', '2000.0'), ('РНДЗ-110/2000', 'status', 'true'),
    ('РНДЗ-220/1000', 'voltage_nom', '220.0'), ('РНДЗ-220/1000', 'current_nom', '1000.0'), ('РНДЗ-220/1000', 'status', 'true'),
    ('РНДЗ-220/2000', 'voltage_nom', '220.0'), ('РНДЗ-220/2000', 'current_nom', '2000.0'), ('РНДЗ-220/2000', 'status', 'true'),
    ('РНДЗ-330/2000', 'voltage_nom', '330.0'), ('РНДЗ-330/2000', 'current_nom', '2000.0'), ('РНДЗ-330/2000', 'status', 'true'),
    ('РНДЗ-500/3150', 'voltage_nom', '500.0'), ('РНДЗ-500/3150', 'current_nom', '3150.0'), ('РНДЗ-500/3150', 'status', 'true'),
    ('РНДЗ-750/3150', 'voltage_nom', '750.0'), ('РНДЗ-750/3150', 'current_nom', '3150.0'), ('РНДЗ-750/3150', 'status', 'true'),
    ('РВ-10/1000', 'voltage_nom', '10.0'), ('РВ-10/1000', 'current_nom', '1000.0'), ('РВ-10/1000', 'status', 'true')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- BUSBARS
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 10 кВ, 2000 А', '—', 'Сборные шины РУ-10 кВ, 2000 А'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 35 кВ, 1000 А', '—', 'Сборные шины РУ-35 кВ, 1000 А'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 110 кВ, 2000 А', '—', 'Сборные шины РУ-110 кВ, 2000 А'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 220 кВ, 2500 А', '—', 'Сборные шины РУ-220 кВ, 2500 А'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 330 кВ, 3150 А', '—', 'Сборные шины РУ-330 кВ, 3150 А'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 500 кВ, 4000 А', '—', 'Сборные шины РУ-500 кВ, 4000 А'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'Шины 750 кВ, 5000 А', '—', 'Сборные шины РУ-750 кВ, 5000 А')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('Шины 10 кВ, 2000 А', 'voltage_nom', '10.0'), ('Шины 10 кВ, 2000 А', 'current_nom', '2000.0'),
    ('Шины 35 кВ, 1000 А', 'voltage_nom', '35.0'), ('Шины 35 кВ, 1000 А', 'current_nom', '1000.0'),
    ('Шины 110 кВ, 2000 А', 'voltage_nom', '110.0'), ('Шины 110 кВ, 2000 А', 'current_nom', '2000.0'),
    ('Шины 220 кВ, 2500 А', 'voltage_nom', '220.0'), ('Шины 220 кВ, 2500 А', 'current_nom', '2500.0'),
    ('Шины 330 кВ, 3150 А', 'voltage_nom', '330.0'), ('Шины 330 кВ, 3150 А', 'current_nom', '3150.0'),
    ('Шины 500 кВ, 4000 А', 'voltage_nom', '500.0'), ('Шины 500 кВ, 4000 А', 'current_nom', '4000.0'),
    ('Шины 750 кВ, 5000 А', 'voltage_nom', '750.0'), ('Шины 750 кВ, 5000 А', 'current_nom', '5000.0')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;

-- ============================================================
-- GROUNDING SWITCHES
-- ============================================================
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'ЗОН-110', 'Электроаппарат', 'Заземлитель 110 кВ'),
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'ЗОН-220', 'Электроаппарат', 'Заземлитель 220 кВ'),
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'ЗОН-500', 'Электроаппарат', 'Заземлитель 500 кВ')
ON CONFLICT DO NOTHING;

INSERT INTO equipment_model_params (equipment_model_id, param_key, param_value)
SELECT e.id, kv, vv FROM equipment_models e, (VALUES
    ('ЗОН-110', 'voltage_nom', '110.0'), ('ЗОН-110', 'status', 'false'),
    ('ЗОН-220', 'voltage_nom', '220.0'), ('ЗОН-220', 'status', 'false'),
    ('ЗОН-500', 'voltage_nom', '500.0'), ('ЗОН-500', 'status', 'false')
) AS t(mn, kv, vv) WHERE e.model_name = t.mn
ON CONFLICT DO NOTHING;