"""Generate project-owned AC networks and independent, pinned PYPOWER references.

No bundled PYPOWER/MATPOWER case data is copied. Generation is optional; Julia
regression tests read the committed JSON without Python or network access.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import scipy
from pypower.api import ppoption, runpf
from pypower.ext2int import ext2int
from pypower.makeYbus import makeYbus


def network(n):
    bus = np.zeros((n, 13))
    bus[:, 0] = 100 + 17 * np.arange(n)  # external IDs deliberately non-contiguous
    bus[:, 1] = 1
    bus[:, 2] = 4 + np.arange(n) % 5
    bus[:, 3] = 1.5 + 0.2 * (np.arange(n) % 4)
    bus[:, 6] = 1
    bus[:, 7] = 1
    bus[:, 9] = 110
    bus[:, 10] = 1
    bus[:, 11:13] = [1.1, 0.9]
    bus[2, 4:6] = [0.5, 2.0]  # shunt GS MW, BS Mvar at |V|=1 p.u.
    gen = np.zeros((3, 21))
    for k, i in enumerate([0, n // 3, 2 * n // 3]):
        bus[i, 1] = 3 if k == 0 else 2
        gen[k, :10] = [bus[i, 0], bus[:, 2].sum() / 3, 0,
                       100, -100, 1.03 - 0.01 * k, 100, 1, 200, 0]
    edges = [(i, (i + 1) % n) for i in range(n)]
    edges += [(i, i + 3) for i in range(0, n - 3, 3)]
    branch = np.zeros((len(edges), 13))
    for k, (f, t) in enumerate(edges):
        branch[k, :5] = [bus[f, 0], bus[t, 0],
                         0.008 + 0.002 * (k % 3), 0.06 + 0.01 * (k % 4), 0.015]
        branch[k, 5:8] = 250
        branch[k, 10:13] = [1, -360, 360]
    branch[0, 8:10] = [1.02, 3.0]  # from-side tap magnitude and phase degrees
    return dict(version="2", baseMVA=100.0, bus=bus, gen=gen, branch=branch)


def transformer_network():
    # Global 110 kV base, including LV. PYPOWER uses a from-side tap;
    # refer series impedance to LV before stamping, tap=Uhv/Ulv.
    case = dict(version="2", baseMVA=100.0)
    case["bus"] = np.array([
        [100, 3, 0, 0, 0, 0, 1, 1.03, 0, 110, 1, 1.1, 0.9],
        [117, 1, 0, 0, 0.1, -np.sqrt(1 - 0.1**2), 1, 1, 0, 110, 1, 1.1, 0.9],
        [134, 1, 10, 3, 0, 0, 1, 10/110, 0, 10, 1, 1.1, 0.9],
    ], dtype=float)
    case["gen"] = np.zeros((1, 21))
    case["gen"][0, :10] = [100, 0, 0, 100, -100, 1.03, 100, 1, 200, 0]
    ratio = 10/110
    case["branch"] = np.array([
        [100, 117, 0.1/121, 0.5/121, 0, 250, 250, 250, 0, 0, 1, -360, 360],
        [117, 134, 0.01*ratio**2, np.sqrt(0.1**2-0.01**2)*ratio**2,
         0, 250, 250, 250, 1/ratio, 0, 1, -360, 360],
    ], dtype=float)
    return case


def compiled_network(n):
    """Physical equipment DTOs and a separately assembled PYPOWER circuit."""
    case = network(n)
    case["bus"][:, 1] = 1  # physical generator terminals are PQ, not ideal PV
    case["bus"][:, 4] = 0
    components, connections, bus_equipment, branch_ids = [], [], [], []

    def component(cid, kind, **params):
        components.append(dict(id=cid, type=kind, params={k: str(v) for k, v in params.items()},
                               x=cid * 0.1, y=cid * -0.2, rotation=0))

    def connect(f, t, fp, tp):
        connections.append(dict(**{"from": int(f), "to": int(t)}, fromPort=fp, toPort=tp))

    for k, row in enumerate(case["bus"]):
        cid = int(row[0])
        component(cid, "busbar", voltage_nom=110)
        component(1000+k, "load", voltage_nom=110, p=row[2], q=row[3])
        connect(cid, 1000+k, "right", "top")
        bus_equipment.append(dict(component_id=cid, internal=False))
    component(4000, "capacitor", voltage_nom=110, q_nom=2)
    connect(case["bus"][2, 0], 4000, "left", "top")
    for k, row in enumerate(case["branch"]):
        cid = 3000+k
        length, circuits = 2.0 + k % 3, 1 + k % 2
        r0, x0, g0, b0 = 0.6 + 0.1*(k % 3), 4 + k % 4, 1e-6, 5e-6
        component(cid, "transmission_line", voltage_nom=110, length=length,
                  circuits=circuits, r0=r0, x0=x0, g0=g0, b0=b0)
        connect(row[0], cid, "right", "left")
        connect(cid, row[1], "right", "left")
        row[2:5] = [r0*length/circuits/121, x0*length/circuits/121,
                    b0*length*circuits*121]
        row[8:10] = 0
        # Active line charging conductance is not a PYPOWER branch column.
        # Represent its equal halves as bus GS at nominal voltage.
        for endpoint in row[:2]:
            i = np.flatnonzero(case["bus"][:, 0] == endpoint)[0]
            case["bus"][i, 4] += g0*length*circuits*110**2/2
        branch_ids.append(cid)
    source_branches = []
    internal_buses = []
    for k, row in enumerate(case["gen"]):
        terminal, internal, cid = int(row[0]), 10000+k, 2000+k
        r, x = 0.3 + 0.1*k, 2.0 + k
        component(cid, "generator", voltage_nom=110, e=row[5]*110,
                  p=row[1], r=r, x=x, is_slack="true" if k == 0 else "false")
        connect(cid, terminal, "bottom", "left")
        internal_buses.append([internal, 3 if k == 0 else 2, 0, 0, 0, 0, 1,
                               row[5], 0, 110, 1, 1.1, 0.9])
        row[0] = internal
        source_branches.append([internal, terminal, r/121, x/121, 0,
                                250, 250, 250, 0, 0, 1, -360, 360])
        bus_equipment.append(dict(component_id=cid, internal=True))
        branch_ids.append(cid)
    case["bus"] = np.vstack([case["bus"], internal_buses])
    case["branch"] = np.vstack([case["branch"], source_branches])
    scheme = dict(components=components, connections=connections,
                  base=dict(s_base_mva=100, v_base_kv=110),
                  solverOptions=dict(tolerance=1e-10, max_iterations=50))
    result = solve_case(case, f"enersy-compiled-{n}-v1")
    # Include line active charging in each physical port, rather than only
    # in the bus shunt used by PYPOWER. Voltage comes from the reference solve.
    ports = np.array(result["expected"]["branch_mw_mvar"])
    for k, row in enumerate(case["branch"][:len(branch_ids)-3]):
        length, circuits = 2.0 + k % 3, 1 + k % 2
        for col, endpoint in [(0, row[0]), (2, row[1])]:
            i = np.flatnonzero(case["bus"][:, 0] == endpoint)[0]
            ports[k, col] += result["expected"]["v_pu"][i]**2 * 1e-6*length*circuits*110**2/2
    result["expected"]["component_port_mw_mvar"] = ports.tolist()
    result.update(scheme=scheme, bus_equipment=bus_equipment, branch_component_ids=branch_ids)
    return result


def solve_case(case, name):
    # Flat start, except prescribed generator magnitudes; Q limits disabled.
    options = ppoption(PF_ALG=1, PF_TOL=1e-10, PF_MAX_IT=50,
                       ENFORCE_Q_LIMS=0, VERBOSE=0, OUT_ALL=0)
    solved, success = runpf(case, options)
    if not success:
        raise RuntimeError(f"reference did not converge: {name}")
    internal = ext2int(case)
    y, _, _ = makeYbus(internal["baseMVA"], internal["bus"], internal["branch"])
    v = solved["bus"][:, 7] * np.exp(1j * np.deg2rad(solved["bus"][:, 8]))
    power = v * np.conj(y @ v)
    return {
        "name": name,
        "base_mva": case["baseMVA"],
        "bus": case["bus"].tolist(), "gen": case["gen"].tolist(),
        "branch": case["branch"].tolist(),
        "expected": {"v_pu": np.abs(v).tolist(),
                     "theta_rad": np.angle(v).tolist(),
                     "p_pu": power.real.tolist(), "q_pu": power.imag.tolist(),
                     "branch_mw_mvar": solved["branch"][:, 13:17].tolist()},
        "y_real": y.toarray().real.tolist(), "y_imag": y.toarray().imag.tolist(),
    }


def q_limit_reference(kind):
    original = compiled_network(9)
    case = dict(version="2", baseMVA=100.0,
                **{key: np.array(original[key]) for key in ["bus", "gen", "branch"]})
    bounds = {"upper": [(1, -20, -5, -5)],
              "lower": [(1, 0, 20, 0)],
              "inactive": [(1, -100, 100, None)],
              "both": [(1, -20, -5, -5), (2, -6, 20, -6)],
              "release": [(1, -100, -5, None), (2, 20, 100, 20)]}[kind]
    scheme = original["scheme"]
    for k, low, high, fixed in bounds:
        component = next(c for c in scheme["components"] if c["id"] == 2000+k)
        component["params"].update(q_min_emf_mvar=str(low), q_max_emf_mvar=str(high))
        if fixed is not None:
            # Independent reference: explicitly solve the known active-set PQ
            # circuit using PYPOWER's ordinary Newton, without Enersy's wrapper.
            i = np.flatnonzero(case["bus"][:, 0] == case["gen"][k, 0])[0]
            case["bus"][i, 1] = 1
            case["gen"][k, 2] = fixed
    result = solve_case(case, "enersy-q-"+kind+"-v1")
    ports = np.array(result["expected"]["branch_mw_mvar"])
    for k, row in enumerate(case["branch"][:-3]):
        for col, endpoint in [(0, row[0]), (2, row[1])]:
            i = np.flatnonzero(case["bus"][:, 0] == endpoint)[0]
            ports[k, col] += result["expected"]["v_pu"][i]**2 * 1e-6*(2+k%3)*(1+k%2)*110**2/2
    result["expected"]["component_port_mw_mvar"] = ports.tolist()
    result.update(scheme=scheme, bus_equipment=original["bus_equipment"],
                  branch_component_ids=original["branch_component_ids"],
                  fixed_q_mvar={str(2000+k): fixed for k, _, _, fixed in bounds if fixed is not None},
                  reference_policy="Explicit independently specified PQ active set; PYPOWER Q enforcement disabled")
    return result


if __name__ == "__main__":
    payload = {
        "schema_version": 1,
        "provenance": {
            "networks": "Project-owned deterministic synthetic networks; no external case data",
            "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "solver": "PYPOWER 5.1.19 Newton PF_ALG=1",
            "numpy": np.__version__, "scipy": scipy.__version__,
            "tolerance_pu": 1e-10, "max_iterations": 50, "q_limits": False,
        },
        "cases": [solve_case(network(n), f"enersy-ac-{n}-v1") for n in [9, 14, 30]],
        "compiled_transformer": solve_case(transformer_network(), "enersy-transformer-loaded-v1"),
        "compiled_networks": [compiled_network(n) for n in [9, 14, 30]],
        "q_limit_networks": [q_limit_reference(kind) for kind in ["upper", "lower", "inactive", "both"]],
        "q_release_network": q_limit_reference("release"),
    }
    Path("/output/ac-networks-v1.json").write_text(
        json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print("Generated independent core, compiled network and transformer references")
