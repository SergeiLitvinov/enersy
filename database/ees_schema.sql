-- Схема базы данных для расчёта режимов ЭЭС

-- Типы компонентов энергосистемы
CREATE TABLE IF NOT EXISTS component_types (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT
);

-- Параметры компонентов (шаблоны)
CREATE TABLE IF NOT EXISTS component_params_template (
    id SERIAL PRIMARY KEY,
    component_type_id INTEGER REFERENCES component_types(id),
    param_key VARCHAR(50) NOT NULL,
    param_name VARCHAR(100) NOT NULL,
    param_type VARCHAR(20) NOT NULL, -- number, string, boolean
    default_value TEXT,
    unit VARCHAR(20),
    UNIQUE(component_type_id, param_key)
);

-- Схемы (проекты)
CREATE TABLE IF NOT EXISTS circuit_schemes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    owner_id INTEGER DEFAULT 1
);

-- Компоненты схемы
CREATE TABLE IF NOT EXISTS scheme_components (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    component_type_id INTEGER REFERENCES component_types(id),
    custom_name VARCHAR(100),
    pos_x REAL NOT NULL DEFAULT 0,
    pos_y REAL NOT NULL DEFAULT 0,
    rotation INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Параметры экземпляров компонентов
CREATE TABLE IF NOT EXISTS scheme_component_params (
    id SERIAL PRIMARY KEY,
    scheme_component_id INTEGER REFERENCES scheme_components(id) ON DELETE CASCADE,
    param_key VARCHAR(50) NOT NULL,
    param_value TEXT NOT NULL,
    UNIQUE(scheme_component_id, param_key)
);

-- Соединения между компонентами
CREATE TABLE IF NOT EXISTS scheme_connections (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    from_component_id INTEGER REFERENCES scheme_components(id) ON DELETE CASCADE,
    to_component_id INTEGER REFERENCES scheme_components(id) ON DELETE CASCADE,
    from_port VARCHAR(50) NOT NULL,
    to_port VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Узлы для расчёта
CREATE TABLE IF NOT EXISTS circuit_nodes (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    node_number INTEGER NOT NULL,
    node_type VARCHAR(20) NOT NULL, -- PQ, PV, Slack
    voltage_magnitude REAL,
    voltage_angle REAL,
    p_specified REAL,
    q_specified REAL,
    UNIQUE(scheme_id, node_number)
);

-- Результаты расчётов
CREATE TABLE IF NOT EXISTS calculation_results (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    calculation_type VARCHAR(50) NOT NULL, -- node_potentials, newton_raphson
    calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL, -- success, error
    error_message TEXT,
    iterations INTEGER,
    computation_time_ms REAL
);

-- Результаты по узлам
CREATE TABLE IF NOT EXISTS calculation_node_results (
    id SERIAL PRIMARY KEY,
    calculation_id INTEGER REFERENCES calculation_results(id) ON DELETE CASCADE,
    node_id INTEGER REFERENCES circuit_nodes(id),
    voltage_magnitude REAL,
    voltage_angle REAL,
    voltage_real REAL,
    voltage_imag REAL,
    p_injected REAL,
    q_injected REAL,
    mismatch REAL
);

-- Результаты по ветвям
CREATE TABLE IF NOT EXISTS calculation_branch_results (
    id SERIAL PRIMARY KEY,
    calculation_id INTEGER REFERENCES calculation_results(id) ON DELETE CASCADE,
    from_component_id INTEGER REFERENCES scheme_components(id),
    to_component_id INTEGER REFERENCES scheme_components(id),
    p_from REAL,
    q_from REAL,
    p_to REAL,
    q_to REAL,
    current_from REAL,
    current_to REAL,
    losses_active REAL,
    losses_reactive REAL
);

-- Заполнение типов компонентов
INSERT INTO component_types (code, name, category, description) VALUES
    ('generator', 'Генератор', 'source', 'Синхронный генератор'),
    ('transformer', 'Трансформатор', 'transform', 'Двухобмоточный трансформатор'),
    ('transformer_3w', 'Трёхобмоточный трансформатор', 'transform', 'Трёхобмоточный трансформатор'),
    ('autotransformer', 'Автотрансформатор', 'transform', 'Автотрансформатор'),
    ('transmission_line', 'Линия электропередачи', 'line', 'Воздушная или кабельная линия'),
    ('breaker', 'Выключатель', 'switch', 'Силовой выключатель'),
    ('disconnector', 'Разъединитель', 'switch', 'Разъединитель'),
    ('grounding_switch', 'Заземлитель', 'switch', 'Заземляющий разъединитель'),
    ('load', 'Нагрузка', 'load', 'Потребитель активной и реактивной мощности'),
    ('ground', 'Заземление', 'ground', 'Узел заземления'),
    ('busbar', 'Сборная шина', 'bus', 'Сборная шина с несколькими присоединениями'),
    ('capacitor', 'Батарея конденсаторов', 'compensation', 'Продольная или поперечная компенсация'),
    ('reactor', 'Реактор', 'compensation', 'Шунтирующий реактор')
ON CONFLICT DO NOTHING;

-- Параметры для генератора
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'generator'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'power_nom', 'Номинальная мощность', 'number', '100.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'r', 'Активное сопротивление', 'number', '0.0', 'Ом'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'x', 'Индуктивное сопротивление', 'number', '0.2', 'Ом'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'e', 'ЭДС', 'number', '115.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'angle', 'Угол ЭДС', 'number', '0.0', 'град'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'p', 'Активная мощность', 'number', '100.0', 'МВт')
ON CONFLICT DO NOTHING;

-- Параметры для трансформатора
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'power_nom', 'Номинальная мощность', 'number', '25.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'voltage_hv', 'Напряжение ВН', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'voltage_lv', 'Напряжение НН', 'number', '10.5', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'p_kz', 'Потери КЗ', 'number', '0.12', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'u_kz', 'Напряжение КЗ', 'number', '10.5', '%'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'p_xx', 'Потери ХХ', 'number', '0.025', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'i_xx', 'Ток ХХ', 'number', '0.7', '%')
ON CONFLICT DO NOTHING;

-- Параметры для линии
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'length', 'Длина', 'number', '50.0', 'км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r0', 'Удельное активное сопротивление', 'number', '0.12', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x0', 'Удельное индуктивное сопротивление', 'number', '0.4', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'b0', 'Удельная ёмкостная проводимость', 'number', '0.0000028', 'См/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'g0', 'Удельная активная проводимость', 'number', '0.0', 'См/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'circuits', 'Число цепей', 'number', '1', ''),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r_aa', 'R фазы A', 'number', '0.12', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_aa', 'X фазы A', 'number', '0.4', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r_bb', 'R фазы B', 'number', '0.12', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_bb', 'X фазы B', 'number', '0.4', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r_cc', 'R фазы C', 'number', '0.12', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_cc', 'X фазы C', 'number', '0.4', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r_ab', 'Взаимное R A-B', 'number', '0.012', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_ab', 'Взаимное X A-B', 'number', '0.04', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r_bc', 'Взаимное R B-C', 'number', '0.012', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_bc', 'Взаимное X B-C', 'number', '0.04', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'r_ca', 'Взаимное R C-A', 'number', '0.012', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_ca', 'Взаимное X C-A', 'number', '0.04', 'Ом/км')
ON CONFLICT DO NOTHING;

-- Параметры для нагрузки
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'load'), 'p', 'Активная мощность', 'number', '50.0', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q', 'Реактивная мощность', 'number', '20.0', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p_a', 'P фазы A', 'number', '16.667', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q_a', 'Q фазы A', 'number', '6.667', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p_b', 'P фазы B', 'number', '16.667', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q_b', 'Q фазы B', 'number', '6.667', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p_c', 'P фазы C', 'number', '16.667', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q_c', 'Q фазы C', 'number', '6.667', 'Мвар')
ON CONFLICT DO NOTHING;

-- Параметры для выключателя
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'current_nom', 'Номинальный ток', 'number', '1250.0', 'А'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'status', 'Статус (включен)', 'boolean', 'true', '')
ON CONFLICT DO NOTHING;

-- Параметры для разъединителя
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'current_nom', 'Номинальный ток', 'number', '1000.0', 'А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'status', 'Статус (включен)', 'boolean', 'true', '')
ON CONFLICT DO NOTHING;

-- Параметры для сборной шины
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'current_nom', 'Номинальный ток', 'number', '2000.0', 'А')
ON CONFLICT DO NOTHING;

-- Параметры для трёхобмоточного трансформатора
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'power_nom', 'Номинальная мощность', 'number', '25.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'voltage_hv', 'Напряжение ВН', 'number', '115.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'voltage_mv', 'Напряжение СН', 'number', '38.5', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'voltage_lv', 'Напряжение НН', 'number', '11.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'p_kz_hv_mv', 'Потери КЗ ВН-СН', 'number', '0.10', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'p_kz_hv_lv', 'Потери КЗ ВН-НН', 'number', '0.10', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'p_kz_mv_lv', 'Потери КЗ СН-НН', 'number', '0.10', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'u_kz_hv_mv', 'Напряжение КЗ ВН-СН', 'number', '10.5', '%'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'u_kz_hv_lv', 'Напряжение КЗ ВН-НН', 'number', '17.0', '%'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'u_kz_mv_lv', 'Напряжение КЗ СН-НН', 'number', '6.5', '%'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'p_xx', 'Потери ХХ', 'number', '0.025', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'i_xx', 'Ток ХХ', 'number', '0.7', '%')
ON CONFLICT DO NOTHING;

-- Параметры для автотрансформатора
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'power_nom', 'Номинальная мощность', 'number', '125.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'voltage_hv', 'Напряжение ВН', 'number', '230.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'voltage_mv', 'Напряжение СН', 'number', '121.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'voltage_lv', 'Напряжение НН', 'number', '11.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'p_kz', 'Потери КЗ', 'number', '0.30', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'u_kz', 'Напряжение КЗ', 'number', '11.0', '%'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'p_xx', 'Потери ХХ', 'number', '0.050', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'i_xx', 'Ток ХХ', 'number', '0.3', '%')
ON CONFLICT DO NOTHING;

-- Параметры для батареи конденсаторов
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'voltage_nom', 'Номинальное напряжение', 'number', '10.5', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'q_nom', 'Номинальная мощность', 'number', '30.0', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'c', 'Ёмкость', 'number', '900.0', 'мкФ')
ON CONFLICT DO NOTHING;

-- Параметры для реактора
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'q_nom', 'Номинальная мощность', 'number', '25.0', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'l', 'Индуктивность', 'number', '0.5', 'Гн')
ON CONFLICT DO NOTHING;

-- Параметры для заземлителя
INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'status', 'Статус (заземлён)', 'boolean', 'false', '')
ON CONFLICT DO NOTHING;

-- Equipment models catalog
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

-- Generators
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

-- Two-winding transformers
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

-- Three-winding transformers
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'ТДТН-25000/110', 'АТМ', 'Трёхобмоточный 25 МВА, 115/38.5/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'ТДТН-40000/110', 'АТМ', 'Трёхобмоточный 40 МВА, 115/38.5/11 кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'ТДТН-63000/110', 'АТМ', 'Трёхобмоточный 63 МВА, 115/38.5/11 кВ')
ON CONFLICT DO NOTHING;

-- Autotransformers
INSERT INTO equipment_models (component_type_id, model_name, manufacturer, description) VALUES
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-125000/220/110', 'АТМ', 'Автотрансформатор 125 МВА, 230/121 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-200000/220/110', 'АТМ', 'Автотрансформатор 200 МВА, 230/121 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-250000/330/110', 'АТМ', 'Автотрансформатор 250 МВА, 330/121 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АТДЦТН-500000/500/220', 'АТМ', 'Автотрансформатор 500 МВА, 525/242 кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'АОДЦТН-167000/500/220', 'АТМ', 'Автотрансформатор 167 МВА (одна фаза), 500/220 кВ')
ON CONFLICT DO NOTHING;

-- Transmission lines
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

-- Loads
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

-- Breakers
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

-- Disconnectors
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

-- Busbars
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

-- Capacitor banks
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

-- Shunt reactors
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

-- Grounding switches
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

-- Keep catalogue provenance while parameters remain an editable instance snapshot.
ALTER TABLE scheme_components ADD COLUMN IF NOT EXISTS equipment_model_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS equipment_models_id_type_idx
    ON equipment_models (id, component_type_id);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'scheme_component_model_type_fk' AND conrelid = 'scheme_components'::regclass) THEN
        ALTER TABLE scheme_components ADD CONSTRAINT scheme_component_model_type_fk
            FOREIGN KEY (equipment_model_id, component_type_id)
            REFERENCES equipment_models (id, component_type_id);
    END IF;
END $$;

-- Legacy port descriptors. This does not declare mathematical model support.
CREATE TABLE IF NOT EXISTS component_type_ports (
    component_type_id INTEGER NOT NULL REFERENCES component_types(id),
    port_name VARCHAR(50) NOT NULL,
    domain VARCHAR(50) NOT NULL,
    PRIMARY KEY (component_type_id, port_name)
);
INSERT INTO component_type_ports(component_type_id,port_name,domain)
SELECT ct.id, p.port_name, 'electrical-ac'
FROM component_types ct JOIN (VALUES
 ('generator','top'),('generator','bottom'),
 ('transformer','top'),('transformer','bottom'),('transformer','left'),('transformer','right'),('transformer','a'),('transformer','b'),
 ('autotransformer','top'),('autotransformer','bottom'),('autotransformer','left'),('autotransformer','right'),('autotransformer','a'),('autotransformer','b'),
 ('transformer_3w','top'),('transformer_3w','bl'),('transformer_3w','br'),('transformer_3w','left'),('transformer_3w','right'),('transformer_3w','bottom'),
 ('transmission_line','left'),('transmission_line','right'),('transmission_line','top'),('transmission_line','bottom'),
 ('breaker','top'),('breaker','bottom'),('disconnector','top'),('disconnector','bottom'),
 ('busbar','left'),('busbar','right'),('load','top'),('ground','top'),('grounding_switch','top'),('capacitor','top'),('reactor','top')
) AS p(code,port_name) ON p.code=ct.code ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS scheme_components_id_scheme_idx ON scheme_components(id,scheme_id);
-- NOT VALID preserves legacy data for an explicit audit; new writes are enforced.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='connection_from_scheme_fk' AND conrelid='scheme_connections'::regclass) THEN
        ALTER TABLE scheme_connections ADD CONSTRAINT connection_from_scheme_fk
            FOREIGN KEY(from_component_id,scheme_id) REFERENCES scheme_components(id,scheme_id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE scheme_connections ADD CONSTRAINT connection_to_scheme_fk
            FOREIGN KEY(to_component_id,scheme_id) REFERENCES scheme_components(id,scheme_id) ON DELETE CASCADE NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION check_connection_ports() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE from_domain TEXT; to_domain TEXT;
BEGIN
    SELECT p.domain INTO from_domain FROM scheme_components c JOIN component_type_ports p
        ON p.component_type_id=c.component_type_id WHERE c.id=NEW.from_component_id AND c.scheme_id=NEW.scheme_id AND p.port_name=NEW.from_port;
    SELECT p.domain INTO to_domain FROM scheme_components c JOIN component_type_ports p
        ON p.component_type_id=c.component_type_id WHERE c.id=NEW.to_component_id AND c.scheme_id=NEW.scheme_id AND p.port_name=NEW.to_port;
    IF from_domain IS NULL OR to_domain IS NULL OR from_domain <> to_domain OR
       (NEW.from_component_id=NEW.to_component_id AND NEW.from_port=NEW.to_port) THEN
        RAISE EXCEPTION 'Unknown, incompatible or identical connection ports' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS connection_ports_check ON scheme_connections;
CREATE TRIGGER connection_ports_check BEFORE INSERT OR UPDATE ON scheme_connections
    FOR EACH ROW EXECUTE FUNCTION check_connection_ports();

CREATE OR REPLACE VIEW invalid_scheme_connections AS
SELECT c.*, array_remove(ARRAY[
    CASE WHEN c.scheme_id IS NULL OR f.scheme_id IS DISTINCT FROM c.scheme_id OR t.scheme_id IS DISTINCT FROM c.scheme_id THEN 'scheme_mismatch' END,
    CASE WHEN fp.domain IS NULL OR tp.domain IS NULL THEN 'unknown_port' END,
    CASE WHEN fp.domain IS NOT NULL AND tp.domain IS NOT NULL AND fp.domain <> tp.domain THEN 'domain_mismatch' END,
    CASE WHEN c.from_component_id=c.to_component_id AND c.from_port=c.to_port THEN 'identical_port' END
], NULL) AS reasons
FROM scheme_connections c
LEFT JOIN scheme_components f ON f.id=c.from_component_id
LEFT JOIN scheme_components t ON t.id=c.to_component_id
LEFT JOIN component_type_ports fp ON fp.component_type_id=f.component_type_id AND fp.port_name=c.from_port
LEFT JOIN component_type_ports tp ON tp.component_type_id=t.component_type_id AND tp.port_name=c.to_port
WHERE c.scheme_id IS NULL OR f.scheme_id IS DISTINCT FROM c.scheme_id OR t.scheme_id IS DISTINCT FROM c.scheme_id
   OR fp.domain IS NULL OR tp.domain IS NULL OR fp.domain <> tp.domain
   OR (c.from_component_id=c.to_component_id AND c.from_port=c.to_port);
