export function normalizeCpf(value) {
  return (value ?? '').replace(/\D/g, '').slice(0, 11)
}

export function maskCpf(value) {
  const digits = normalizeCpf(value)
  return digits
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
}

export function isValidCpf(value) {
  const digits = normalizeCpf(value)
  if (digits.length !== 11) return false
  if (/^(\d)\1{10}$/.test(digits)) return false

  const calcCheckDigit = (base) => {
    let sum = 0
    for (let i = 0; i < base.length; i += 1) {
      sum += Number(base[i]) * (base.length + 1 - i)
    }
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }

  const firstDigit = calcCheckDigit(digits.slice(0, 9))
  const secondDigit = calcCheckDigit(digits.slice(0, 10))

  return firstDigit === Number(digits[9]) && secondDigit === Number(digits[10])
}
