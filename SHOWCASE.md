# Handshake showcase kit: LoadPath

Copy-paste material for your Handshake profile (Projects / showcase), resume and LinkedIn. Written for **mechanical engineering** roles: design, structures, product, aerospace/automotive, additive manufacturing, and simulation/CAE.

---

## Project title
**LoadPath: AI Generative Design Studio (FEA + Topology Optimization)**

## One-line tagline (≤ 120 chars)
Describe a part in plain English. AI sets up the load case and a from-scratch FEA solver grows the lightest structure.

## Short description (Handshake project description)
LoadPath is a browser-based generative design tool I built from scratch. You describe a part, for example "a 3D-printed shelf bracket holding 15 kg, bolted at the top and bottom", and Claude converts it into a structural load case: supports, forces, and keep-out/keep-in regions. My own finite-element solver (Q4 plane-stress elements, banded Cholesky with a reanalysis preconditioner) then runs SIMP topology optimization with density filtering and Heaviside projection to find the stiffest layout for the material budget. A verification analysis reports mass, stiffness, von Mises stress and safety factor against yield. The part exports as an STL for 3D printing or an SVG for laser cutting. I validated the solver against Timoshenko beam theory (0.7% error) with an automated test suite.

## Skills to tag
Finite Element Analysis (FEA) · Topology Optimization · Generative Design · Structural Analysis · Mechanics of Materials · Numerical Methods · Design for Manufacturing (DFM) · Additive Manufacturing · Machine Learning / AI · Claude API · JavaScript · Data Visualization · Technical Writing

## Resume bullets (pick 2–3)
- Developed **LoadPath**, a browser-based generative design tool that runs **finite-element topology optimization (SIMP)** on 2,000–5,000-element meshes and exports 3D-printable STL parts; across six benchmark parts it cut mass **46–75%** versus solid plates while keeping a **safety factor ≥ 2**, converging in under 15 s on a 2016 laptop.
- Wrote a **2D plane-stress FEA solver** from scratch (Q4 elements, banded Cholesky, factor-reuse preconditioned CG), validated against **Timoshenko beam theory to 0.7%**, plus patch tests and adjoint-gradient finite-difference checks in a 21-test automated suite.
- Integrated **Claude (LLM)** to turn plain-English design briefs into JSON-schema-validated boundary conditions, and to generate **vision-based design reviews** covering load paths, safety margins and DFM for CNC, laser cutting and 3D printing.
- Implemented density filtering, Heaviside projection with β-continuation and optimality-criteria updates. Added verification FEA that reports von Mises stress, deflection and the required thickness for a target safety factor.

## "Tell me about this project" (30-second pitch)
> "Generative design is how parts like aerospace brackets get their organic shapes, but the commercial tools are black boxes. So I built one from scratch. You describe a part in plain English, and Claude turns that into supports and loads. Then my own finite-element solver runs topology optimization in the browser. You watch the material disappear from where it isn't needed until a truss or an arch is left. It checks the final part for stress and safety factor and exports an STL. I validated the solver against beam theory, and it's within 0.7%."

## Interview talking points (be ready to go deep)
1. **Why SIMP with p = 3?** Penalizing intermediate densities makes gray material structurally inefficient, which pushes the design toward 0/1. With the filter, the problem stays well-posed and mesh-independent.
2. **Why a density filter and projection?** Without a filter you get checkerboards and mesh-dependent solutions. The filter radius sets a minimum member size, which is a manufacturing constraint. Heaviside projection with β-continuation then sharpens the gray boundary into a crisp, buildable part. Grayness ends under 2%.
3. **How do you know the FEA is right?** A patch test (uniform stress exact to 10⁻⁸), a cantilever against Timoshenko theory (0.7%), rigid-body modes of the element matrix, and a finite-difference check of the adjoint sensitivities. Q4 elements are slightly too stiff in bending (shear locking), and you can see the mesh-refinement test converge toward the analytical answer.
4. **Solver performance.** The bottleneck is factorizing K every iteration. Between design updates K changes only slightly, so I reuse the previous Cholesky factor as a preconditioner for conjugate gradients and refactor only when CG stalls. Nodes are numbered along the short side to keep the bandwidth small.
5. **Stress singularities.** Point loads produce theoretically infinite stress, so I put solid pads under loads and exclude those elements from the peak-stress report. A real design would model the actual contact patch or bolt.
6. **Where does AI help, and where doesn't it?** The LLM handles the fuzzy parts: interpreting a brief, filling in reasonable defaults and listing its assumptions, and reviewing the design like a senior engineer would. Physics stays deterministic and verifiable. Claude never decides the shape, and its output is schema-validated and clamped before it reaches the solver.
7. **What would you do next?** Stress-constrained optimization, multiple load cases, AM overhang constraints, a multigrid preconditioner for finer meshes, and 3D voxel optimization.

## Media to upload
- `assets/screenshots/hero.jpg`: brief → optimized shelf bracket with verified results
- `assets/screenshots/overview.jpg`: bowstring bridge, full studio view
- `assets/screenshots/stress.jpg`: von Mises stress map of the cantilever truss
- `assets/screenshots/3d.jpg`: 3D extrusion ready for STL export
- *(Highly recommended)* a 30–60 s screen recording: type a brief → Generate setup → Optimize (the shape forming live is the money shot) → Stress view → 3D view → Export STL. Bonus: a photo of the printed part.

## Links
- Live demo: `https://kenny-robinson1978.github.io/loadpath/`
- Source: `https://github.com/kenny-robinson1978/loadpath`
