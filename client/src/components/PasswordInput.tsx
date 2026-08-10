import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Used in the toggle button's aria-label, e.g. "RCON password" */
  label?: string
  maxLength?: number
  id?: string
  autoComplete?: string
}

// Defaults hidden (type="password") and toggles to type="text" on click —
// shared by every RCON/SFTP password field so the show/hide behavior and
// aria-labeling stay consistent instead of being re-implemented per form.
export function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
  label = 'password',
  maxLength,
  id,
  autoComplete,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        className={cn('pr-10', className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute right-1 top-1 h-9 w-9 p-0"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  )
}
