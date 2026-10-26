module RootCurvatureDiagnostics

using LinearAlgebra, SparseArrays
import EnersyCompute

"""Offline curvature of a special uniform-R/X, series-only, all-PQ problem.

For Y=(g-jb)L, rotate S by 1/(b-jg). The equivalent admittance is -jL.
In coordinates (theta, rho=log|V|), the rotated power derivative is the Hessian
of sum(w*|Vi-Vj|²/2) minus the linear specified-P/Q terms. One slack is fixed.
This is an algebraic diagnostic, NOT a dynamic stability certificate or a
general network filter. Shunts, taps, PV and ZIP require a different derivation.
The caller supplies the common impedance explicitly; the original Y is untouched.
"""
function edge_hessian(setup::EnersyCompute.PowerFlowSetup, edges, voltage;
                      common_impedance::ComplexF64, ratio_tolerance=1e-12)
    coordinate=case_coordinates(setup,voltage,common_impedance,ratio_tolerance)
    m=length(setup.pq)
    rows,cols,values=Int[],Int[],Float64[]
    function stamp(i,j,value)
        if i>0 && j>0
            push!(rows,i);push!(cols,j);push!(values,value)
        end
    end
    for edge in edges
        i,j,z=series_edge(edge,setup.nbus)
        w=uniform_weight(z,common_impedance,ratio_tolerance)
        vi2,vj2=abs2(voltage[i]),abs2(voltage[j])
        product=voltage[i]*conj(voltage[j])
        c,s=w*real(product),w*imag(product)
        ti,tj=coordinate[i],coordinate[j]
        ri,rj=ti==0 ? 0 : m+ti,tj==0 ? 0 : m+tj
        stamp(ti,ti,c);stamp(tj,tj,c);stamp(ti,tj,-c);stamp(tj,ti,-c)
        for (a,b,value) in ((ti,ri,s),(ti,rj,s),(tj,ri,-s),(tj,rj,-s))
            stamp(a,b,value);stamp(b,a,value)
        end
        stamp(ri,ri,2w*vi2-c);stamp(rj,rj,2w*vj2-c)
        stamp(ri,rj,-c);stamp(rj,ri,-c)
    end
    H=sparse(rows,cols,values,2m,2m)
    dropzeros!(H)
    all(isfinite,nonzeros(H)) || throw(ArgumentError("nonfinite curvature matrix"))
    H
end

function series_edge(edge,nbus)
    # Do not silently discard an extra tap/shunt field while destructuring.
    edge isa Tuple{Int,Int,ComplexF64} || throw(ArgumentError("only explicit (from,to,series_z) edges are supported"))
    i,j,z=edge
    1<=i<=nbus && 1<=j<=nbus && i!=j || throw(ArgumentError("invalid edge endpoints"))
    edge
end

function case_coordinates(setup,voltage,common_impedance,ratio_tolerance)
    EnersyCompute.validate_setup(setup)
    isempty(setup.pv) && isempty(setup.voltage_demands) ||
        throw(ArgumentError("curvature diagnostic supports constant-PQ buses only"))
    length(voltage) == setup.nbus && all(v -> isfinite(v) && abs(v)>0, voltage) ||
        throw(ArgumentError("finite nonzero phasors required for every bus"))
    isfinite(common_impedance) && !iszero(common_impedance) ||
        throw(ArgumentError("explicit finite nonzero common impedance required"))
    isfinite(ratio_tolerance) && 0 < ratio_tolerance <= 1e-8 ||
        throw(ArgumentError("invalid common-ratio comparison tolerance"))
    m=length(setup.pq)
    coordinate=zeros(Int,setup.nbus)
    for (k,bus) in enumerate(setup.pq); coordinate[bus]=k; end
    coordinate
end

function uniform_weight(z,common,tolerance)
    isfinite(z) && !iszero(z) || throw(ArgumentError("finite nonzero series impedance required"))
    ratio=common/z
    isfinite(ratio) && real(ratio)>0 && abs(imag(ratio))<=tolerance*max(1,abs(ratio)) ||
        throw(ArgumentError("edges do not share the declared R/X ratio"))
    real(ratio)
end

"""Unshifted LDL', with an independently evaluated negative direction.

Failed/zero-pivot factorizations are refused. A positive factorization only
describes this Hessian at this point, not the stability of electrical machines.
The returned witness is in original (unpermuted) theta/log-voltage coordinates.
"""
function classify(H::SparseMatrixCSC{Float64})
    size(H,1)>0 && size(H,1)==size(H,2) && issymmetric(H) && all(isfinite,nonzeros(H)) ||
        throw(ArgumentError("finite nonempty symmetric Hessian required"))
    factor=ldlt(Symmetric(H);check=false,shift=0.0)
    issuccess(factor) || throw(ArgumentError("curvature factorization failed"))
    d=diag(sparse(factor.LD))
    all(v -> isfinite(v) && !iszero(v),d) || throw(ArgumentError("zero/nonfinite curvature pivot"))
    count_negative=count(<(0.0),d)
    witness=nothing
    rayleigh=nothing
    if count_negative>0
        rhs=zeros(size(H,1));rhs[findfirst(<(0.0),d)]=1
        # UP is L'P, so its solve restores CHOLMOD's permutation.
        witness=factor.UP\rhs
        witness./=norm(witness)
        all(isfinite,witness) || throw(ArgumentError("nonfinite curvature witness"))
        rayleigh=dot(witness,H*witness)
        isfinite(rayleigh) && rayleigh<0 || throw(ArgumentError("negative direction not reproduced"))
    end
    (; status=count_negative==0 ? "positive_ldlt" : "negative_direction",
       negative_pivots=count_negative,min_pivot=minimum(d),rayleigh,witness)
end

"""Independent 128-bit evaluation of the edge quadratic form for a witness.

No sparse Hessian/factorization is used here. Precision applies only inside the
offline do-block; this diagnostic is not installed in the request hot path.
"""
function edge_quadratic(setup,edges,voltage,direction;common_impedance::ComplexF64)
    coordinate=case_coordinates(setup,voltage,common_impedance,1e-12)
    m=length(setup.pq)
    length(direction)==2m && all(isfinite,direction) || throw(ArgumentError("invalid direction"))
    setprecision(BigFloat,128) do
        total=BigFloat(0)
        for edge in edges
            i,j,z=series_edge(edge,setup.nbus)
            w=BigFloat(uniform_weight(z,common_impedance,1e-12))
            a,b=Complex{BigFloat}(voltage[i]),Complex{BigFloat}(voltage[j])
            c,s=w*real(a*conj(b)),w*imag(a*conj(b))
            k,l=coordinate[i],coordinate[j]
            ti,tj=k==0 ? BigFloat(0) : BigFloat(direction[k]),l==0 ? BigFloat(0) : BigFloat(direction[l])
            ri,rj=k==0 ? BigFloat(0) : BigFloat(direction[m+k]),l==0 ? BigFloat(0) : BigFloat(direction[m+l])
            total+=c*(ti-tj)^2+2s*(ti-tj)*(ri+rj)+
                (2w*abs2(a)-c)*ri^2+(2w*abs2(b)-c)*rj^2-2c*ri*rj
        end
        total
    end
end

end # module
