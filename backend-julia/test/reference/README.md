# Independent AC references v1

## Transformer phase-shift references

`transformer-phase-v1.json` contains six project-owned 110/10 kV circuits solved
by the same pinned PYPOWER 5.1.19 container: zero, ±15°, ±30°, and parallel
transformers with +5°/−5° shifts. Positive Enersy phi means LV leads HV at no
series current. PYPOWER uses from-side taps, hence SHIFT=−phi and LV-referred
series impedance. Its bus magnetizing shunts are included in transformer port
powers/currents using independently solved voltages. No external case data or
solver source is copied. The package/license notes below apply.

Regenerate using the existing reference image (not a runtime dependency):

```powershell
docker build -t enersy-ac-reference backend-julia/test/reference
docker run --rm --network none --entrypoint python --mount type=bind,source=C:/project/enersy/backend-julia/test/reference,target=/reference enersy-ac-reference /reference/generate_transformer_phase.py /reference/transformer-phase-v1.json
```

The JSON records LF-normalized SHA-256 hashes of its generator, shared original
circuit generator and pinned Dockerfile. Tests require the hashes to match.

The networks `enersy-ac-{9,14,30}-v1` are deterministic synthetic networks
authored for this project. They are **not IEEE benchmark cases**. No external
case data or solver source is redistributed. The generator and network data
are original project contributions; the project licensing task BASE-08 remains
open and this fixture does not assign a new project-wide license.

`compiled_transformer` is a separate loaded 110/10 kV network, also original
project data, used to verify the editor DTO-to-calculation compiler. Its
magnetization is represented as an HV bus shunt in PYPOWER; port comparisons
include that shunt to match Enersy's transformer boundary.

`compiled_networks` contains original physical DTO schemes with 9/14/30
network buses and 3 extra internal source buses each. A separate PYPOWER
assembly includes source series impedances, line charging and parallel
circuits. Line active charging is represented as bus GS in PYPOWER; its
physical port contribution is recorded separately using reference voltages.
Tests cover the actual compiler, renumbering/geometry invariants and real HTTP.

`q_limit_networks` contains independent, explicitly prescribed PQ active sets
for upper/lower/inactive/two-source internal EMF Q bounds. PYPOWER's automatic
Q enforcement is disabled: it solves those separately specified equations.
This validates the selected physical outcomes, not every active-set trajectory.

`q_release_network` independently specifies a feasible final PV/PQ state:
source 2001 regulates voltage within [-100,-5] Mvar, while 2002 holds 20 Mvar.
The initially violated upper bound of 2001 becomes inactive after 2002 is
constrained. This detects overconstraint by a monotone PV-to-PQ policy.

The reference solver is [PYPOWER 5.1.19](https://pypi.org/project/PYPOWER/5.1.19/)
(BSD-3-Clause code; copyright PSERC and Richard Lincoln). Its bundled case data
is explicitly excluded from that code license, and is not used here.
NumPy 1.26.4 (BSD-3-Clause) and SciPy 1.13.1 (BSD-3-Clause) are installed in an
optional, separate container. Consult each distribution's notices for bundled
third-party libraries. None is a runtime dependency of Enersy.

Regenerate from the repository root in PowerShell:

```powershell
docker build -t enersy-ac-reference backend-julia/test/reference
docker run --rm --network none -v "${PWD}/backend-julia/test/reference:/output" enersy-ac-reference
docker run --rm --network none -v "${PWD}/backend-julia:/app:ro" enersy-julia-compute julia --project=/app /app/test/runtests.jl
```

`ac-networks-v1.json` records raw inputs, the generator SHA-256, solver and
dependency versions, options, Y and independently solved results. Keep these
inputs and expected outputs together; do not update expected values merely to
make a changed solver pass. Regeneration is separate from normal CI tests,
which use the checked-in JSON without Python or network access.

Specifications and acceptance tolerances are documented in
[`numerical-validation.md`](../../../docs/site/development/numerical-validation.md).

## Independent ZIP references

`zip-networks-v1.json` is generated separately by pandapower 3.5.3 (BSD-3-Clause).
Only the physical `scheme` inputs and equipment identity map of the original
compiled networks are read; their expected values and Y matrices are not used.
The new cases have 9/14/30 physical buses plus three internal EMF buses, diverse
independent P/Q ZIP fractions, two additional loads at one bus rated at 107 and
112 kV, and a fourth case with a source constrained to -5 Mvar at its internal
EMF. They are original project data, not IEEE cases. This does not assign a new
license to the project; BASE-08 remains open.

The generator assembles buses, sources behind impedances, pi-lines with active
and reactive charging, parallel circuits and a capacitor using pandapower's
high-level circuit API. The line thermal rating of 1 kA is required metadata
only: no thermal limit is enforced, compared or claimed as equipment data.
The algorithm is balanced Newton with ZIP enabled, flat start, 1e-9 MVA
tolerance, 50 iterations, Q enforcement, no distributed slack, numba or
lightsim2grid. pandapower is never a runtime dependency of Enersy.

### Shared-bus aggregation caveat

Directly supplying separate loads with different power ratings and ZIP fractions
at one bus in pandapower 3.5.3 produced a balance error of approximately
0.0656 MW / 0.0195 Mvar in the first fixture. The installed
`pandapower.build_bus._calc_pq_elements_and_add_on_ppc` takes the arithmetic mean
of percentages by load count. That conversion is unsuitable for these unequal
profiles. The generator does not patch the solver or delete these loads.

Instead, it exactly sums the physical polynomial coefficients at each bus:
for each load, constant/linear/quadratic terms are converted from device U_nom
to the bus voltage base, then summed separately for P and Q. One electrically
equivalent ZIP load is supplied to pandapower per bus. Individual device powers
are reconstructed from the independently solved voltages and original curves;
their sums must match native `res_load` outputs to 1e-8 MW/Mvar. The overall
external power balance must be within 1e-6 MW/Mvar. No artificial impedance is
introduced. Current fixtures have nonnegative aggregate polynomial coefficients;
signed individual Q is included. Arbitrary signed aggregate polynomials are not
covered by this adapter.

### Regeneration and provenance

```powershell
docker build -f backend-julia/test/reference/Dockerfile.zip -t enersy-zip-reference backend-julia/test/reference
docker run --rm --network none --mount "type=bind,source=${PWD}/backend-julia/test/reference,target=/output" enersy-zip-reference
docker run --rm --network none --mount "type=bind,source=${PWD}/backend-julia,target=/app,readonly" enersy-julia-compute julia --project=. --startup-file=no test/runtests.jl
```

The Python base image digest and every installed package version are fixed in
`Dockerfile.zip` and `requirements-zip.txt`; `pip check` verifies dependencies.
The JSON records solver options, dependency versions and SHA-256 of the generator,
requirements, original input file and installed pandapower `build_bus.py`.
Source hashes normalize CRLF to LF for reproducibility across checkouts.
The source file of the pinned external solver is identified but not redistributed.
Consult each Python distribution for notices of bundled third-party software.

Julia compares nodes, individual loads, both ends of every branch, currents,
capacitor power, balances and Q clamping on the original case, a different common
base, remapped IDs/reversed wires/moved symbols, and HTTP input. Tests run offline
using committed JSON; dependency installation and regeneration are separate from CI.
Do not change expected values to accommodate a changed Enersy solver.
