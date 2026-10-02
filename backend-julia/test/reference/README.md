# Independent AC references v1

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
