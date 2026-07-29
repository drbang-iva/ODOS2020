# ODOS touch input primitives

These controls implement the app-wide touchscreen contract: every target is at least 44px high, adjacent targets have at least 8px of space, and every interaction remains available to mouse and keyboard users. They use the charting Tailwind palette from `tailwind.config.js`.

## Choosing a control

- Use `OdosWheel` for bounded numeric ranges. `centerOn` is required, and typed values clamp to `min`/`max` and snap to `step` on blur.
- Use `OdosSelect` for enumerable single values. `states` keeps non-numeric states visible above the scrolling list.
- Use `OdosChips` for genuinely multi-valued fields. Combination products must arrive as one catalog option.
- Use `OdosSearchPicker` for open sets backed by search. Its text is only a query; a result or newly created option is the selected value.
- Wrap a measurement with `MethodField` when its capture method is a separate bound value.
- Wrap per-eye controls with `EyePairRow` for bidirectional copying and an editable Recorded On timestamp.

## Prism recipe

Magnitude and base direction are separate coded fields. Compose a wheel and select; never concatenate them into one value.

```tsx
<div className="grid gap-2 sm:grid-cols-2">
  <OdosWheel
    value={prismMagnitude}
    centerOn={0}
    min={0}
    max={20}
    step={0.25}
    format={(value) => value === 0 ? "pl" : value.toFixed(2)}
    unit="Δ"
    ariaLabel="Prism magnitude"
    onChange={setPrismMagnitude}
  />
  <OdosSelect
    value={prismBase}
    defaultValue="BI"
    options={[
      { value: "BI", label: "Base in" },
      { value: "BO", label: "Base out" },
      { value: "BU", label: "Base up" },
      { value: "BD", label: "Base down" },
    ]}
    ariaLabel="Prism base direction"
    onChange={setPrismBase}
  />
</div>
```

Persist `prismMagnitude` and `prismBase` independently.

## Cascade-wiring recipe

The upstream field owns the selected context. Resolve the downstream catalog options from that context, clear a stale downstream selection when the context changes, and pass `loading` so the control renders its built-in loading state.

```tsx
const [manufacturer, setManufacturer] = useState("");
const [products, setProducts] = useState<OdosSelectOption<string>[]>([]);
const [product, setProduct] = useState("");
const [loadingProducts, setLoadingProducts] = useState(false);
const [productsError, setProductsError] = useState<string>();

useEffect(() => {
  let cancelled = false;
  setProduct("");
  setProductsError(undefined);
  setLoadingProducts(true);
  loadProducts(manufacturer).then((rows) => {
    if (!cancelled) setProducts(rows.map((row) => ({ value: row.id, label: row.name })));
  }).catch((cause: unknown) => {
    if (!cancelled) {
      setProducts([]);
      setProductsError(cause instanceof Error ? cause.message : String(cause));
    }
  }).finally(() => {
    if (!cancelled) setLoadingProducts(false);
  });
  return () => { cancelled = true; };
}, [manufacturer]);

<OdosSelect
  value={manufacturer}
  options={manufacturerOptions}
  ariaLabel="Manufacturer"
  onChange={setManufacturer}
/>
<OdosSelect
  value={product}
  options={products}
  loading={loadingProducts}
  disabled={!manufacturer}
  ariaLabel="Product"
  onChange={setProduct}
/>
{productsError && <p role="alert">{productsError}</p>}
```

For numeric catalog parameters, derive `min`, `max`, `step`, and required `centerOn` from the selected product and pass them to `OdosWheel`. The same stale-value clearing rule applies.
