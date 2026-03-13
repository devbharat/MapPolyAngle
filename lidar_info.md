Yes. For **straight, level flight over flat ground**, you can model Wingtra’s ground point density with a compact set of parameters, and the published Wingtra numbers are internally consistent once you account for the fact that the **Hesai XT32M2X is a native 360° spinning lidar**, while Wingtra specifies a **90° horizontal mapping FOV** for its payload. 

The key published parameters are these:

* **Sensor**: Hesai XT32M2X, **32 channels**. 
* **Native horizontal FOV**: **360°**. 
* **Wingtra effective horizontal FOV for mapping**: **90°**. 
* **Vertical FOV**: **40.3°**, with channel angles from **+19.5° to -20.8°** and **1.3° vertical spacing**. 
* **Spin / frame rate options**: **5, 10, 20 Hz** (300, 600, 1200 RPM). 
* **Horizontal angular resolution**: **0.09° at 5 Hz**, **0.18° at 10 Hz**, **0.36° at 20 Hz**. 
* **Native pulse / point rates**: **640 k/s single return**, **1280 k/s dual**, **1920 k/s triple** in Wingtra’s tech sheet. 
* Wingtra’s knowledge base also states an **effective ground-directed rate** of **160k pts/s single return** and **480k pts/s for the third return / triple-return case**, which matches taking only **90° of the lidar’s native 360° sweep**. ([knowledge.wingtra.com][1])

The cleanest way to compute **average single-pass ground density** is:

[
D_{\text{single-pass}} \approx \frac{R_{\text{eff}}}{v , W}
]

where:

* (D) = point density on ground ([\text{pts}/m^2])
* (R_{\text{eff}}) = **effective usable point rate toward mapped ground**
* (v) = ground speed ([m/s])
* (W) = ground swath width ([m])

For Wingtra’s stated **90° horizontal FOV**, if that 90° sector is centered symmetrically on nadir over flat ground, then:

[
W(h)=2h\tan\left(\frac{90^\circ}{2}\right)=2h
]

so the density becomes:

[
D_{\text{single-pass}} \approx \frac{R_{\text{eff}}}{2hv}
]

with (h) = altitude above flat ground. 

Using the native Wingtra pulse specs, the effective mapping-sector rate is:

[
R_{\text{eff}} = R_{\text{native}} \cdot \frac{90^\circ}{360^\circ}
]

So, approximately:

* **single return**: (640k \times 0.25 = 160k) pts/s
* **dual return**: (1280k \times 0.25 = 320k) pts/s
* **triple return**: (1920k \times 0.25 = 480k) pts/s 

That gives the practical formula set:

[
D_{1} \approx \frac{160000}{2hv}
]

[
D_{2} \approx \frac{320000}{2hv}
]

[
D_{3} \approx \frac{480000}{2hv}
]

for single-, dual-, and triple-return average densities, respectively, before overlap / filtering losses. 

If you also want to include **side overlap** (s) between adjacent straight flight lines, then for uniform coverage the average deliverable density scales roughly as:

[
D_{\text{with overlap}} \approx \frac{D_{\text{single-pass}}}{1-s}
]

So:

* 30% overlap (\rightarrow \times 1.43)
* 50% overlap (\rightarrow \times 2)

That matches Wingtra’s published examples: at **45 m AGL**, **single pass**, **single return**, Wingtra says **110 pt/m²**; with the formula this implies a ground speed of about **16.2 m/s**, which is plausible for the platform. The same speed also reproduces Wingtra’s **~110 pt/m² at 90 m AGL with 50% overlap** and **~84 pt/m² at 120 m AGL with 50% overlap**. ([knowledge.wingtra.com][1])

A useful cross-check is that **spin rate does not materially change average density** here. The lidar’s horizontal angular step gets coarser as spin rate rises: 0.09°, 0.18°, 0.36° at 5/10/20 Hz. That keeps the average single-return throughput effectively constant, so spin rate mostly changes **sampling pattern / anisotropy**, not the average pts/m². 

The parameters you actually need are therefore:

1. **Altitude above ground** (h)
2. **Ground speed** (v)
3. **Effective horizontal mapping FOV** (\phi_h = 90^\circ)
4. **Effective point rate** (R_{\text{eff}}), which depends on return mode
5. **Side overlap** (s), if you want final deliverable density rather than single-pass density 

The parameters that matter only for a **more exact spatial distribution model**, not the average density, are:

* channel count = 32
* exact vertical channel angles from +19.5° to -20.8°
* vertical spacing = 1.3°
* spin rate / angular step
* boresight / mounting tilt and exact sector orientation on the aircraft 

That last point matters: if you want the **true cross-track density profile** instead of average pts/m², you also need the **payload mounting geometry**. Without the exact Wingtra boresight / tilt, you can compute average density reliably, but not the exact per-channel footprint spacing across the swath. The public sources above do not fully expose that mount geometry. 

For most planning work, I’d use this as the working model:

[
\boxed{D \approx \frac{R_{\text{native}}(\text{return mode}) \cdot (\phi_h/360^\circ)}{v \cdot 2h\tan(\phi_h/2)}}
]

and for Wingtra specifically with (\phi_h=90^\circ):

[
\boxed{D \approx \frac{R_{\text{native}}(\text{return mode})}{8hv}}
]

with overlap added as:

[
\boxed{D_{\text{deliverable}} \approx \frac{D}{1-s}}
]

If you want, I’ll turn this into a small calculator table or a Python function that takes altitude, speed, overlap, and return mode and outputs expected pts/m².

[1]: https://knowledge.wingtra.com/en/lidar-general-setup "LIDAR General Setup"
   At **66 m AGL**, the single-pass density is:

[
D \approx \frac{R_{\text{eff}}}{2hv}
]

So for Wingtra’s lidar at **66 m**:

[
D \approx \frac{R_{\text{eff}}}{132,v}
]

with (v) in m/s.

Using Wingtra’s effective mapping-sector rates:

* **Single return**: (R_{\text{eff}} \approx 160{,}000) pts/s
  [
  D_1 \approx \frac{160000}{132,v} = \frac{1212.1}{v}\ \text{pts/m}^2
  ]

* **Dual return**: (R_{\text{eff}} \approx 320{,}000) pts/s
  [
  D_2 \approx \frac{2424.2}{v}\ \text{pts/m}^2
  ]

* **Triple return**: (R_{\text{eff}} \approx 480{,}000) pts/s
  [
  D_3 \approx \frac{3636.4}{v}\ \text{pts/m}^2
  ]

So the answer depends directly on **flight speed**.

A few useful values:

| Speed  | Single return |  Dual return | Triple return |
| ------ | ------------: | -----------: | ------------: |
| 10 m/s |  121.2 pts/m² | 242.4 pts/m² |  363.6 pts/m² |
| 12 m/s |  101.0 pts/m² | 202.0 pts/m² |  303.0 pts/m² |
| 15 m/s |   80.8 pts/m² | 161.6 pts/m² |  242.4 pts/m² |
| 16 m/s |   75.8 pts/m² | 151.5 pts/m² |  227.3 pts/m² |

If you want the **deliverable density with line overlap**, multiply by:

[
\frac{1}{1-s}
]

So for example at **66 m**, **single return**, **16 m/s**:

* **0% overlap**: **75.8 pts/m²**
* **30% overlap**: (75.8 / 0.7 \approx 108.3) pts/m²
* **50% overlap**: (75.8 / 0.5 \approx 151.5) pts/m²

If you give me the **speed** and **overlap**, I’ll give you the exact number.

