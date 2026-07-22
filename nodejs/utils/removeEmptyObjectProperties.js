const removeEmptyObjectProperties = (obj) => {
  Object.entries(obj)
    .map(([k, v]) => {
      if (v && typeof v === 'object') return [k, removeEmptyObjectProperties(v)]
      return [k, v]
    })
    .reduce((a, [k, v]) => {
      if (v === null || v === false || v === '') return a

      a[k] = v
      return a
    }, {})
}
