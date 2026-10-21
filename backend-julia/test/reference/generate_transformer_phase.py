"""Original transformer circuits solved by pinned PYPOWER, never by Enersy.

Run in the reference Docker image, mounting this directory at /reference:ro.
Positive Enersy phi means LV leads HV; PYPOWER's from-side SHIFT is -phi.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from generate import transformer_network, solve_case
from pypower.ext2int import ext2int
from pypower.makeYbus import makeYbus


def reference(shifts):
    case = transformer_network()
    transformer = case["branch"][1].copy()
    case["branch"] = np.vstack([case["branch"][0]] + [transformer.copy() for _ in shifts])
    case["branch"][1:, 9] = -np.array(shifts)
    case["bus"][1, 4:6] *= len(shifts)  # one HV magnetizing branch per transformer
    solved = solve_case(case, "transformer-phase-" + "-".join(map(str, shifts)))
    expected = solved["expected"]
    voltages = np.array(expected["v_pu"]) * np.exp(1j * np.array(expected["theta_rad"]))
    internal = ext2int(case)
    _, yf, yt = makeYbus(100, internal["bus"], internal["branch"])
    currents_from, currents_to = yf @ voltages, yt @ voltages
    ports = np.array(expected["branch_mw_mvar"])
    magnetizing = (0.1 - 1j * np.sqrt(1 - 0.1**2)) / 100
    for k in range(1, len(shifts) + 1):
        power = 100 * abs(voltages[1])**2 * np.conj(magnetizing)
        ports[k, :2] += [power.real, power.imag]
        currents_from[k] += magnetizing * voltages[1]
    expected["branch_mw_mvar"] = ports.tolist()
    expected["i_from_ka"] = (abs(currents_from) * 100 / (np.sqrt(3) * 110)).tolist()
    expected["i_to_ka"] = (abs(currents_to) * 100 / (np.sqrt(3) * 110)).tolist()
    components = []
    def add(cid, kind, **params):
        components.append(dict(id=cid, type=kind, params={key: str(value) for key, value in params.items()}))
    add(1, "generator", voltage_nom=110, e=113.3, p=0, r=0.1, x=0.5)
    add(2, "busbar", voltage_nom=110)
    add(3, "busbar", voltage_nom=10)
    add(5, "load", voltage_nom=10, p=10, q=3)
    connections = [dict(**{"from": 1, "to": 2}, fromPort="bottom", toPort="left"),
                   dict(**{"from": 3, "to": 5}, fromPort="right", toPort="top")]
    branch_ids = [1]
    for k, shift in enumerate(shifts):
        cid = 4 if k == 0 else 6
        add(cid, "transformer", power_nom=100, voltage_hv=110, voltage_lv=10,
            p_kz=1, u_kz=10, p_xx=0.1, i_xx=1, phase_shift_deg=shift)
        connections += [dict(**{"from": 2, "to": cid}, fromPort="right", toPort="top"),
                        dict(**{"from": cid, "to": 3}, fromPort="bottom", toPort="left")]
        branch_ids.append(cid)
    solved.update(scheme=dict(components=components, connections=connections,
        base=dict(s_base_mva=100, v_base_kv=110), solverOptions=dict(tolerance=1e-11, max_iterations=50)),
        node_owners=[dict(id=1, internal=True), dict(id=2, internal=False), dict(id=3, internal=False)],
        branch_ids=branch_ids, shifts=shifts)
    return solved


if __name__ == "__main__":
    root = Path(__file__).parent
    payload = dict(schema_version=1, provenance=dict(solver="PYPOWER 5.1.19", numpy=np.__version__,
        files={name: hashlib.sha256((root / name).read_text().replace("\r\n", "\n").encode()).hexdigest()
               for name in ["generate_transformer_phase.py", "generate.py", "Dockerfile"]},
        convention="phi=arg(V_LV/V_HV) at zero series current; PYPOWER SHIFT=-phi; HV magnetizing shunts included in transformer port flows"),
        cases=[reference(shifts) for shifts in [[0], [30], [-30], [15], [-15], [5, -5]]])
    Path(sys.argv[1]).write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n")
