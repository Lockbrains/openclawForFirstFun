package ai.firstclaw.android.ui

import androidx.compose.runtime.Composable
import ai.firstclaw.android.MainViewModel
import ai.firstclaw.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
