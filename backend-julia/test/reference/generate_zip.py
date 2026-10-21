"""Independent ZIP references assembled with pandapower, never with Enersy code.

Only physical input schemes from ac-networks-v1.json are consumed. Existing
expected values and Y matrices are not used. No external network cases copied.
"""
import copy
import hashlib
import importlib.metadata
import inspect
import json
import math
import platform
from pathlib import Path

import numpy as np
import pandapower as pp

HERE = Path(__file__).resolve().parent
OPTIONS = dict(algorithm="nr", calculate_voltage_angles=True, init="flat",
               max_iteration=50, tolerance_mva=1e-9, voltage_depend_loads=True,
               enforce_q_lims=True, numba=False, lightsim2grid=False,
               distributed_slack=False, trafo_model="pi", run_control=False)
ZIP_KEYS = ("zip_p_z", "zip_p_i", "zip_p_p", "zip_q_z", "zip_q_i", "zip_q_p")
FRACTIONS = (((1., 0., 0.), (1., 0., 0.)),
             ((0., 1., 0.), (0., 1., 0.)),
             ((0., 0., 1.), (0., 0., 1.)),
             ((.2, .3, .5), (.4, .1, .5)),
             ((.1, .6, .3), (.5, .2, .3)),
             ((.8, .1, .1), (.1, .8, .1)))


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def rated_zip(power, fractions, bus_kv, device_kv):
    """Express physical U/device_U polynomial on pandapower's bus voltage base."""
    z, i, p = fractions
    ratio = bus_kv / device_kv
    return np.array([power*z*ratio**2, power*i*ratio, power*p])


def pp_zip(parts):
    """Convert summed power polynomial coefficients to pandapower percentages."""
    total = float(parts.sum())
    if np.any(parts < 0): raise ValueError("Reference aggregate requires nonnegative power coefficients")
    return (total, 100*parts[0]/total, 100*parts[1]/total) if total else (0., 0., 0.)


def scheme_for(original, q_clamp):
    scheme = copy.deepcopy(original["scheme"])
    loads = [c for c in scheme["components"] if c["type"] == "load"]
    for k, load in enumerate(loads):
        p, q = FRACTIONS[k % len(FRACTIONS)]
        load["params"].update(zip_enabled="true", **{
            key: str(value) for key, value in zip(ZIP_KEYS, p+q)})
    # Two loads share one physical terminal but have their own ratings/profiles.
    first_bus = original["bus_equipment"][0]["component_id"]
    for cid, voltage, p, q, pf, qf in (
            (6001, 107., 1.2, .35, (.3, .2, .5), (.1, .7, .2)),
            (6002, 112., .8, -.15, (.1, .5, .4), (.6, .1, .3))):
        scheme["components"].append(dict(id=cid, type="load", x=11., y=-19., rotation=90,
            params={"p": str(p), "q": str(q), "voltage_nom": str(voltage),
                    "zip_enabled": "true", **{key: str(value) for key, value in zip(ZIP_KEYS, pf+qf)}}))
        scheme["connections"].append({"from": first_bus, "to": cid, "fromPort": "right", "toPort": "top"})
    if q_clamp:
        source = next(c for c in scheme["components"] if c["id"] == 2001)
        source["params"].update(q_min_emf_mvar="-5", q_max_emf_mvar="-5")
    return scheme


def assemble(scheme):
    """Independent high-level circuit assembly in physical kV, MW, Mvar, Ohm/km."""
    net = pp.create_empty_network(sn_mva=100., f_hz=50.)
    components = {c["id"]: c for c in scheme["components"]}
    buses, internals, devices, load_groups = {}, {}, {}, {}
    for c in components.values():
        if c["type"] == "busbar":
            buses[c["id"]] = pp.create_bus(net, vn_kv=float(c["params"]["voltage_nom"]), index=c["id"])
    def terminal(cid, port=None):
        matches = []
        for e in scheme["connections"]:
            if e["from"] == cid and (port is None or e["fromPort"] == port): matches.append(e["to"])
            if e["to"] == cid and (port is None or e["toPort"] == port): matches.append(e["from"])
        if len(matches) != 1 or matches[0] not in buses:
            raise ValueError(f"Non-bus or ambiguous fixture terminal: {cid}/{port}")
        return buses[matches[0]]
    for cid, c in components.items():
        p, kind = c["params"], c["type"]
        if kind == "load":
            bus = terminal(cid)
            pf = tuple(float(p[key]) for key in ZIP_KEYS[:3])
            qf = tuple(float(p[key]) for key in ZIP_KEYS[3:])
            pparts = rated_zip(float(p["p"]), pf, net.bus.at[bus, "vn_kv"], float(p["voltage_nom"]))
            qparts = rated_zip(float(p["q"]), qf, net.bus.at[bus, "vn_kv"], float(p["voltage_nom"]))
            load_groups.setdefault(bus, []).append((cid, pparts, qparts))
        elif kind == "generator":
            bus = terminal(cid)
            rated = float(p["voltage_nom"])
            internal = pp.create_bus(net, vn_kv=rated, index=10000+cid)
            internals[cid] = internal
            zbase = rated**2 / 100.
            branch = pp.create_impedance(net, internal, bus, rft_pu=float(p["r"])/zbase,
                xft_pu=float(p["x"])/zbase, sn_mva=100.)
            devices[cid] = ("impedance", branch)
            if p.get("is_slack") == "true":
                pp.create_ext_grid(net, internal, vm_pu=float(p["e"])/rated, va_degree=0.)
            else:
                bounds = {target: float(p[key]) for target, key in (
                    ("min_q_mvar", "q_min_emf_mvar"), ("max_q_mvar", "q_max_emf_mvar")) if key in p}
                pp.create_gen(net, internal, p_mw=float(p["p"]), vm_pu=float(p["e"])/rated,
                    **bounds)
        elif kind == "transmission_line":
            branch = pp.create_line_from_parameters(net, terminal(cid, "left"), terminal(cid, "right"),
                length_km=float(p["length"]), r_ohm_per_km=float(p["r0"]), x_ohm_per_km=float(p["x0"]),
                c_nf_per_km=float(p["b0"])/(2*math.pi*50)*1e9,
                g_us_per_km=float(p["g0"])*1e6, parallel=int(p["circuits"]), max_i_ka=1.)
            devices[cid] = ("line", branch)
        elif kind == "capacitor":
            devices[cid] = ("shunt", pp.create_shunt(net, terminal(cid), p_mw=0.,
                q_mvar=-float(p["q_nom"]), vn_kv=float(p["voltage_nom"])))
        elif kind != "busbar":
            raise ValueError(f"Unsupported reference equipment {kind}")
    # pandapower 3.5.3 averages percentages by load count at a shared bus, not
    # by nominal power. Sum polynomial coefficients first: this is an exact
    # electrical equivalent, with no artificial impedance or solver patch.
    for bus, entries in load_groups.items():
        pd, pz, pi = pp_zip(sum((e[1] for e in entries), np.zeros(3)))
        qd, qz, qi = pp_zip(sum((e[2] for e in entries), np.zeros(3)))
        idx = pp.create_load(net, bus, p_mw=pd, q_mvar=qd,
            const_z_p_percent=pz, const_i_p_percent=pi, const_z_q_percent=qz, const_i_q_percent=qi)
        for cid, _, _ in entries: devices[cid] = ("load", idx)
    return net, components, buses, internals, devices


def solve(original, q_clamp=False):
    scheme = scheme_for(original, q_clamp)
    net, components, buses, internals, devices = assemble(scheme)
    pp.runpp(net, **OPTIONS)
    if not net.converged: raise RuntimeError("Independent ZIP solve failed")
    injections = {bus: np.zeros(2) for bus in net.bus.index}
    loads, branches, shunts = [], [], []
    group_powers = {idx: np.zeros(2) for idx in net.load.index}
    for idx, row in net.res_load.iterrows():
        injections[int(net.load.at[idx, "bus"])] -= [row.p_mw, row.q_mvar]
    for cid, (kind, idx) in devices.items():
        row = net[f"res_{kind}"].loc[idx]
        if kind == "load":
            bus = int(net.load.at[idx, "bus"])
            p = components[cid]["params"]
            voltage = net.res_bus.at[bus, "vm_pu"] * net.bus.at[bus, "vn_kv"]
            ratio = voltage / float(p["voltage_nom"])
            individual = []
            for part in ("p", "q"):
                fractions = [float(p[f"zip_{part}_{term}"]) for term in ("z", "i", "p")]
                individual.append(float(p[part]) * (fractions[0]*ratio**2 + fractions[1]*ratio + fractions[2]))
            group_powers[idx] += individual
            loads.append(dict(component_id=cid, p_mw=individual[0], q_mvar=individual[1], voltage_kv=float(voltage)))
        elif kind in ("line", "impedance"):
            branches.append(dict(component_id=cid, **{key: float(row[key]) for key in
                ("p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar", "i_from_ka", "i_to_ka")}))
        elif kind == "shunt":
            shunts.append(dict(component_id=cid, p_mw=float(row.p_mw), q_mvar=float(row.q_mvar)))
    for idx, actual in group_powers.items():
        external = net.res_load.loc[idx, ["p_mw", "q_mvar"]].to_numpy(float)
        if np.max(np.abs(actual - external)) > 1e-8: raise AssertionError("Reference ZIP profile was not applied")
    for kind in ("gen", "ext_grid"):
        for idx, element in net[kind].iterrows():
            injections[int(element.bus)] += net[f"res_{kind}"].loc[idx, ["p_mw", "q_mvar"]].to_numpy(float)
    generated = sum((injections[bus] for bus in internals.values()), np.zeros(2))
    consumed = np.array([sum(row[key] for row in loads) for key in ("p_mw", "q_mvar")])
    losses = np.array([sum(row["p_from_mw"] + row["p_to_mw"] for row in branches),
                       sum(row["q_from_mvar"] + row["q_to_mvar"] for row in branches)])
    shunt_power = np.array([sum(row[key] for row in shunts) for key in ("p_mw", "q_mvar")])
    residual = generated - consumed - losses - shunt_power
    if np.max(np.abs(residual)) > 1e-6: raise AssertionError(f"Independent solver balance failed: {residual}")
    nodes = []
    for member in original["bus_equipment"]:
        cid = member["component_id"]
        bus = internals[cid] if member["internal"] else buses[cid]
        row = net.res_bus.loc[bus]
        nodes.append(dict(**member, v_pu=float(row.vm_pu), theta_rad=float(np.deg2rad(row.va_degree)),
            p_pu=float(injections[bus][0]/100), q_pu=float(injections[bus][1]/100)))
    pq_net = copy.deepcopy(net)
    pq_totals = {idx: np.zeros(2) for idx in net.load.index}
    for cid, (kind, idx) in devices.items():
        if kind == "load":
            pq_totals[idx] += [float(components[cid]["params"][part]) for part in ("p", "q")]
    for idx, values in pq_totals.items(): pq_net.load.loc[idx, ["p_mw", "q_mvar"]] = values
    pp.runpp(pq_net, **{**OPTIONS, "voltage_depend_loads": False})
    delta = float(np.max(np.abs(net.res_bus.vm_pu - pq_net.res_bus.vm_pu)))
    if delta <= 1e-6: raise AssertionError("ZIP fixture indistinguishable from constant PQ")
    return dict(name=original["name"].replace("compiled", "zip") + ("-q-clamp" if q_clamp else ""),
        scheme=scheme, expected=dict(nodes=nodes, loads=loads, branches=branches, shunts=shunts),
        constant_pq_voltage_difference_pu=delta, reference_balance_residual_mw_mvar=residual.tolist(),
        q_clamped_components=[2001] if q_clamp else [])


if __name__ == "__main__":
    if pp.__version__ != "3.5.3": raise RuntimeError("Pinned pandapower version required")
    if not {"const_z_p_percent", "const_i_p_percent", "const_z_q_percent", "const_i_q_percent"}.issubset(inspect.signature(pp.create_load).parameters):
        raise RuntimeError("Independent active/reactive ZIP profiles unavailable")
    original = json.loads((HERE / "ac-networks-v1.json").read_text())
    cases = original["compiled_networks"]
    payload = dict(schema_version=1, provenance=dict(
        networks="Project-owned physical input schemes; no external network cases or expected values copied",
        solver="pandapower 3.5.3 balanced Newton-Raphson with voltage-dependent loads",
        python=platform.python_version(), generator_sha256=digest(Path(__file__)),
        input_sha256=digest(HERE / "ac-networks-v1.json"),
        requirements_sha256=digest(HERE / "requirements-zip.txt"),
        pandapower_build_bus_sha256=digest(Path(pp.__file__).parent / "build_bus.py"),
        packages={name: importlib.metadata.version(name) for name in ("pandapower", "numpy", "scipy", "pandas")},
        options=OPTIONS, line_thermal_rating_ka=1.,
        load_aggregation="Exact per-bus sum of Z/I/P power polynomial coefficients before pandapower conversion; individual powers reconstructed from external voltages and original profiles, checked against native aggregate results",
        thermal_rating_scope="Required line metadata only; no thermal limits enforced or validated"),
        cases=[solve(case) for case in cases] + [solve(cases[0], q_clamp=True)])
    Path("/output/zip-networks-v1.json").write_text(json.dumps(payload, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    print("Generated four independent ZIP references with distinct P/Q fractions")
