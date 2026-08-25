import React from 'react'
import { withTranslation, type WithTranslation } from 'react-i18next'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { reportClientError } from '@/lib/client-errors'

interface Props extends WithTranslation {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

// Class component -- useTranslation() is a hook and doesn't work here.
// withTranslation() HOC injects `t` as a prop instead (see FeatureErrorBoundary.tsx
// for the same pattern, deliberately kept identical between the two boundaries).
class ErrorBoundaryBase extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    reportClientError('ErrorBoundary caught an error.', { error, errorInfo })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const { t } = this.props
      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
          <Card className="max-w-md w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-6 h-6" />
                {t('title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                {t('description')}
              </p>
              {this.state.error && (
                <pre className="p-3 bg-muted rounded-lg text-sm overflow-auto max-h-32">
                  {this.state.error.message}
                </pre>
              )}
              <div className="flex gap-2">
                <Button onClick={() => window.location.reload()}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('refreshPage')}
                </Button>
                <Button variant="outline" onClick={this.handleReset}>
                  {t('tryAgain')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}

export const ErrorBoundary = withTranslation('errorBoundary')(ErrorBoundaryBase)
