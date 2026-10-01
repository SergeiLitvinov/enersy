CREATE TABLE IF NOT EXISTS component_types (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS component_params_template (
    id SERIAL PRIMARY KEY,
    component_type_id INTEGER REFERENCES component_types(id),
    param_key VARCHAR(50) NOT NULL,
    param_name VARCHAR(100) NOT NULL,
    param_type VARCHAR(20) NOT NULL,
    default_value TEXT,
    unit VARCHAR(20),
    UNIQUE(component_type_id, param_key)
);

CREATE TABLE IF NOT EXISTS circuit_schemes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    owner_id INTEGER DEFAULT 1
);

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

CREATE TABLE IF NOT EXISTS scheme_component_params (
    id SERIAL PRIMARY KEY,
    scheme_component_id INTEGER REFERENCES scheme_components(id) ON DELETE CASCADE,
    param_key VARCHAR(50) NOT NULL,
    param_value TEXT NOT NULL,
    UNIQUE(scheme_component_id, param_key)
);

CREATE TABLE IF NOT EXISTS scheme_connections (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    from_component_id INTEGER REFERENCES scheme_components(id) ON DELETE CASCADE,
    to_component_id INTEGER REFERENCES scheme_components(id) ON DELETE CASCADE,
    from_port VARCHAR(50) NOT NULL,
    to_port VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS circuit_nodes (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    node_number INTEGER NOT NULL,
    node_type VARCHAR(20) NOT NULL,
    voltage_magnitude REAL,
    voltage_angle REAL,
    p_specified REAL,
    q_specified REAL,
    UNIQUE(scheme_id, node_number)
);

CREATE TABLE IF NOT EXISTS calculation_results (
    id SERIAL PRIMARY KEY,
    scheme_id INTEGER REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    calculation_type VARCHAR(50) NOT NULL,
    calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL,
    error_message TEXT,
    iterations INTEGER,
    computation_time_ms REAL
);

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

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

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

INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'generator'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'power_nom', 'Номинальная мощность', 'number', '100.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'r', 'Активное сопротивление', 'number', '0.0', 'Ом'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'x', 'Индуктивное сопротивление', 'number', '0.2', 'Ом'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'e', 'ЭДС', 'number', '115.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'generator'), 'angle', 'Угол ЭДС', 'number', '0.0', 'град'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'power_nom', 'Номинальная мощность', 'number', '25.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'voltage_hv', 'Напряжение ВН', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'voltage_lv', 'Напряжение НН', 'number', '10.5', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'p_kz', 'Потери КЗ', 'number', '0.12', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'u_kz', 'Напряжение КЗ', 'number', '10.5', '%'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'p_xx', 'Потери ХХ', 'number', '0.025', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'transformer'), 'i_xx', 'Ток ХХ', 'number', '0.7', '%'),
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
    ((SELECT id FROM component_types WHERE code = 'transmission_line'), 'x_ca', 'Взаимное X C-A', 'number', '0.04', 'Ом/км'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p', 'Активная мощность', 'number', '50.0', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q', 'Реактивная мощность', 'number', '20.0', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p_a', 'P фазы A', 'number', '16.667', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q_a', 'Q фазы A', 'number', '6.667', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p_b', 'P фазы B', 'number', '16.667', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q_b', 'Q фазы B', 'number', '6.667', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'p_c', 'P фазы C', 'number', '16.667', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'load'), 'q_c', 'Q фазы C', 'number', '6.667', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'current_nom', 'Номинальный ток', 'number', '1250.0', 'А'),
    ((SELECT id FROM component_types WHERE code = 'breaker'), 'status', 'Статус (включен)', 'boolean', 'true', ''),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'current_nom', 'Номинальный ток', 'number', '1000.0', 'А'),
    ((SELECT id FROM component_types WHERE code = 'disconnector'), 'status', 'Статус (включен)', 'boolean', 'true', ''),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'busbar'), 'current_nom', 'Номинальный ток', 'number', '2000.0', 'А')
ON CONFLICT DO NOTHING;

INSERT INTO component_params_template (component_type_id, param_key, param_name, param_type, default_value, unit) VALUES
    ((SELECT id FROM component_types WHERE code = 'generator'), 'p', 'Активная мощность', 'number', '100.0', 'МВт')
ON CONFLICT DO NOTHING;

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
    ((SELECT id FROM component_types WHERE code = 'transformer_3w'), 'i_xx', 'Ток ХХ', 'number', '0.7', '%'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'power_nom', 'Номинальная мощность', 'number', '125.0', 'МВА'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'voltage_hv', 'Напряжение ВН', 'number', '230.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'voltage_mv', 'Напряжение СН', 'number', '121.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'voltage_lv', 'Напряжение НН', 'number', '11.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'p_kz', 'Потери КЗ', 'number', '0.30', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'u_kz', 'Напряжение КЗ', 'number', '11.0', '%'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'p_xx', 'Потери ХХ', 'number', '0.050', 'МВт'),
    ((SELECT id FROM component_types WHERE code = 'autotransformer'), 'i_xx', 'Ток ХХ', 'number', '0.3', '%'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'voltage_nom', 'Номинальное напряжение', 'number', '10.5', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'q_nom', 'Номинальная мощность', 'number', '30.0', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'capacitor'), 'c', 'Ёмкость', 'number', '900.0', 'мкФ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'q_nom', 'Номинальная мощность', 'number', '25.0', 'Мвар'),
    ((SELECT id FROM component_types WHERE code = 'reactor'), 'l', 'Индуктивность', 'number', '0.5', 'Гн'),
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'voltage_nom', 'Номинальное напряжение', 'number', '110.0', 'кВ'),
    ((SELECT id FROM component_types WHERE code = 'grounding_switch'), 'status', 'Статус (заземлён)', 'boolean', 'false', '')
ON CONFLICT DO NOTHING;

INSERT INTO users (name) VALUES ('Alice'), ('Bob') ON CONFLICT DO NOTHING;